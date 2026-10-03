import { existsSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  createLocalUieFromEnvironment,
  createUieRuleFallbackExtractor,
  localUieScriptPath,
  parseUieExtractionTargets,
  type UieExtraction,
} from './local-uie'

const source = '张三在星河公司工作。'
const extraction: UieExtraction = {
  model: 'uie-base', rawOutput: {}, entities: [], fields: [], relations: [{
    subject: { label: '人物', text: '张三', start: 0, end: 2, score: 0.94 },
    predicate: '所属组织',
    object: { label: '企业', text: '星河公司', start: 3, end: 7, score: 0.9 },
    score: 0.9,
  }],
}
const rule = { content: '规则事实', metadata: { kind: 'identity' } }

describe('shared UIE with rules fallback', () => {
  it('accepts new domain extraction targets and rejects malformed or unbounded schema input', () => {
    expect(parseUieExtractionTargets('样品→存放位置、检测结果；设备->故障；芯片'))
      .toEqual([{ 样品: ['存放位置', '检测结果'] }, { 设备: ['故障'] }, '芯片'])
    for (const invalid of ['', '设备→', '→故障', '设备→故障→原因', 'x'.repeat(101)])
      expect(() => parseUieExtractionTargets(invalid)).toThrow()
    expect(() => parseUieExtractionTargets(Array.from({ length: 65 }, (_, i) => `类型${i}`).join('；'))).toThrow()
  })
  it('automatically qualifies a clear grounded UIE relation alongside rules', async () => {
    const onGraphExtraction = vi.fn()
    const extractor = createUieRuleFallbackExtractor({
      uie: { extract: vi.fn().mockResolvedValue(extraction) },
      rules: () => [rule],
      onGraphExtraction,
    })
    const candidates = await extractor({ userMessage: source, assistantMessage: '',
      metadata: { sourceMessageIds: ['message-1'] } })
    expect(candidates).toHaveLength(2)
    expect(candidates[0]).toEqual(rule)
    expect(candidates[1]).toMatchObject({ metadata: { requiresReview: false, extractionChannel: 'uie-base-local',
      autoReviewPolicy: 'uie-grounded-assertion-v2' } })
    expect(onGraphExtraction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      sourceId: 'message-1', modelId: 'uie-base', status: 'complete',
    }))
  })

  it('returns the unchanged rules result when the model or graph sink fails', async () => {
    const onError = vi.fn()
    const missingModel = createUieRuleFallbackExtractor({
      uie: { extract: async () => { throw new Error('model unavailable') } },
      rules: () => [rule], onError,
    })
    expect(await missingModel({ userMessage: source, assistantMessage: '' })).toEqual([rule])
    expect(onError).toHaveBeenCalledOnce()
    const failedSink = createUieRuleFallbackExtractor({
      uie: { extract: async () => extraction }, rules: () => [rule],
      onGraphExtraction: () => { throw new Error('storage unavailable') },
    })
    expect(await failedSink({ userMessage: source, assistantMessage: '' })).toEqual([rule])
  })

  it('deduplicates a UIE candidate already supplied by rules', async () => {
    const extractor = createUieRuleFallbackExtractor({
      uie: { extract: async () => extraction },
      rules: () => [{ ...rule, content: '张三的所属组织：星河公司' }],
    })
    expect(await extractor({ userMessage: source, assistantMessage: '' })).toHaveLength(1)
  })

  it('locates the shared script and respects explicit model configuration', () => {
    expect(existsSync(localUieScriptPath)).toBe(true)
    const unavailable = createLocalUieFromEnvironment({
      CONTINUUM_MEMORY_UIE_PYTHON: 'missing-python',
      CONTINUUM_MEMORY_UIE_MODEL_PATH: 'missing-model',
    })
    expect(unavailable.isReady()).toBe(false)
  })
})
