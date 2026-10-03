import { describe, expect, it } from 'vitest'
import { extractLocalOpenAssertions } from '../long-term/open-assertion-extractor'
import { localOpenExtractionCases } from './local-open-extraction-cases'
import { createLocalUieFromEnvironment } from '../long-term/local-uie'

const tupleKey = (relation: string, participants: string[]) => JSON.stringify([relation, [...participants].sort()])

describe('local open extraction feasibility diagnostics', () => {
  it('measures the existing rule baseline against independent relation-participant labels', () => {
    let expected = 0, predicted = 0, matched = 0
    const details = localOpenExtractionCases.map(sample => {
      const result = extractLocalOpenAssertions(sample.text)
      const gold = new Set(sample.gold.map(g => tupleKey(g.relation, g.participants)))
      const predictions = new Set(result.assertions.map(a => tupleKey(a.relationText,
        a.participants.map(p => result.entities.find(e => e.id === p.mentionId)!.text))))
      const correct = [...predictions].filter(key => gold.has(key)).length
      expected += gold.size; predicted += predictions.size; matched += correct
      for (const entity of result.entities)
        expect(sample.text.slice(entity.span.start, entity.span.end)).toBe(entity.text)
      for (const assertion of result.assertions)
        expect(sample.text.slice(assertion.relationSpan!.start, assertion.relationSpan!.end)).toBe(assertion.relationText)
      return { id: sample.id, expected: gold.size, predicted: predictions.size, matched: correct,
        output: [...predictions], missing: [...gold].filter(key => !predictions.has(key)) }
    })
    expect(details).toHaveLength(16)
    expect(expected).toBeGreaterThan(0)
    console.info('LOCAL_OPEN_RULE_BASELINE', JSON.stringify({ cases: details.length, expected, predicted, matched,
      precision: predicted ? matched / predicted : null, recall: matched / expected, details,
      realModel: false, productionRepresentativeness: false, contextAccuracyMeasured: false }))
  })

  it.skipIf(process.env.CONTINUUM_TEST_LOCAL_OPEN_UIE !== '1')('runs broad-goal UIE without rule fallback', async () => {
    const model = createLocalUieFromEnvironment()
    try {
      for (const sample of localOpenExtractionCases) {
        const result = await model.extract(sample.text, ['实体提及', '关系措辞', '事件触发词',
          { 实体提及: ['关系措辞', '关联对象'] }])
        // Raw outputs only: finding separate spans is not proof of correct tuple assembly.
        console.info('LIVE_BROAD_UIE', JSON.stringify({ id: sample.id, result }))
      }
    } finally { model.dispose() }
  }, 180000)
})
