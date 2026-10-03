import { describe, expect, it } from 'vitest'
import { createLocalUieFromEnvironment, parseUieOutput } from '../long-term/local-uie'
import { localOpenExtractionCases } from './local-open-extraction-cases'
import { observedSpans, probeSchema, runUieOpenProbe, UIE_OPEN_PROBE_STRATEGIES } from './uie-open-strategy-probe'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

describe('UIE open-goal experimental runner (not production extraction)', () => {
  it('defines structural goals rather than a domain verb whitelist', () => {
    for (const strategy of UIE_OPEN_PROBE_STRATEGIES.filter(s => s !== 'domain-baseline')) {
      const schema = JSON.stringify(probeSchema(strategy, '晶体A外延生长于衬底B'))
      expect(schema).not.toContain('外延生长于')
      expect(schema).not.toContain('居住地')
    }
  })
  it('retains full source context and exact clause offsets without claiming coreference resolution', async () => {
    const source = '如果设备修好，样品S7放入冷柜C；🧪样品S8放入冷柜D。'
    const result = await runUieOpenProbe(source, 'clause-predicate', async text => parseUieOutput(text, {}))
    expect(result.source).toBe(source)
    expect(result.calls).toHaveLength(3)
    for (const call of result.calls) expect(source.slice(call.sourceStart, call.sourceEnd)).toBe(call.text)
  })
  it('generates follow-up questions from extracted predicate spans rather than expected labels', async () => {
    const source = '晶体A外延生长于衬底B'
    const result = await runUieOpenProbe(source, 'predicate-followup', async (text, schema) => parseUieOutput(text,
      schema[0] === '谓词' ? { 谓词: [{ text: '外延生长于', start: 3, end: 8, probability: 0.3 }] } : {}))
    expect(result.calls).toHaveLength(2)
    expect(result.calls[1]!.schema).toContain('关系“外延生长于”的主体')
    expect(result.followupTruncated).toBe(false)
  })
  it('does not invent a second round when no predicate was found', async () => {
    const result = await runUieOpenProbe('空调坏了', 'predicate-followup', async text => parseUieOutput(text, {}))
    expect(result.calls).toHaveLength(1)
  })
  it('fails visibly on model errors without substituting rules', async () => {
    await expect(runUieOpenProbe('空调坏了', 'predicate-centered', async () => { throw new Error('model unavailable') }))
      .rejects.toThrow('model unavailable')
  })
  it('counts only exact source spans, including code-point offsets after emoji', () => {
    const call = { sourceStart: 0, sourceEnd: 5, text: '🧪空调坏了', schema: [], elapsedMs: 0,
      raw: { 状态词: [{ text: '坏了', start: 3, end: 5, relations: {
        对象: [{ text: '空调', start: 1, end: 3 }, { text: '冰箱', start: 1, end: 3 }] } }] } }
    expect(observedSpans(call)).toEqual(['坏了', '空调'])
  })
})

describe('installed UIE strategy matrix (real model, no fallback)', () => {
  it.skipIf(process.env.CONTINUUM_TEST_LOCAL_OPEN_UIE !== '1')('checks a concrete-target positive control', async () => {
    const model = createLocalUieFromEnvironment()
    try {
      const text = '2月8日上午北京冬奥会自由式滑雪女子大跳台决赛中中国选手谷爱凌以188.25分获得金牌！'
      const result = await model.extract(text, ['时间', '选手', '赛事名称'])
      console.info('LIVE_UIE_POSITIVE_CONTROL', JSON.stringify(result.rawOutput))
      expect(result.entities.some(entity => entity.text === '谷爱凌')).toBe(true)
    } finally { model.dispose() }
  }, 120000)
  it.skipIf(process.env.CONTINUUM_TEST_LOCAL_OPEN_UIE !== '1')('prints real outputs for every strategy and sample', async () => {
    const model = createLocalUieFromEnvironment()
    const rows: Record<string, unknown>[] = []
    const reportDirectory = fileURLToPath(new URL('../../../../tmp/local-uie-test/reports/', import.meta.url))
    const summaries = new Map<string, { cases: number; relationSpanHits: number; expectedRelations: number; calls: number; elapsedMs: number }>()
    try {
      for (const strategy of UIE_OPEN_PROBE_STRATEGIES) {
        for (const sample of localOpenExtractionCases) {
          const result = await runUieOpenProbe(sample.text, strategy, (text, schema) => model.extract(text, schema))
          const spans = new Set(result.calls.flatMap(observedSpans))
          const row = { id: sample.id, realModel: true, ...result,
            relationSpanHits: sample.gold.filter(g => spans.has(g.relation)).length,
            expectedRelations: sample.gold.length, tupleAccuracy: null,
            warning: 'Separate span coverage is not correct participant pairing; inspect raw tuples independently.' }
          rows.push(row)
          const summary = summaries.get(strategy) ?? { cases: 0, relationSpanHits: 0, expectedRelations: 0, calls: 0, elapsedMs: 0 }
          summary.cases++; summary.relationSpanHits += row.relationSpanHits; summary.expectedRelations += row.expectedRelations
          summary.calls += result.calls.length; summary.elapsedMs += result.calls.reduce((sum, call) => sum + call.elapsedMs, 0)
          summaries.set(strategy, summary)
          console.info('LIVE_UIE_PROBE_PROGRESS', JSON.stringify({ strategy, id: sample.id, hits: row.relationSpanHits,
            raw: process.env.CONTINUUM_UIE_VERBOSE === '1' ? result.calls : undefined }))
        }
      }
      console.info('LIVE_UIE_PROBE_SUMMARY', JSON.stringify(Object.fromEntries(summaries)))
    } finally {
      model.dispose()
      mkdirSync(reportDirectory, { recursive: true })
      writeFileSync(join(reportDirectory, 'strategy-raw-results.json'), JSON.stringify({ completed: rows.length === 96,
        rows, summaries: Object.fromEntries(summaries), modelQualityPassed: null }, null, 2))
    }
  }, 600000)
})
