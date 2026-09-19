import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  MEMORY_MULTI_BASELINE_STRATEGIES,
  runMemoryMultiBaselineEval,
  type MemoryMultiBaselineFixture,
} from './memory-multi-baseline-eval'

const fixturePath = fileURLToPath(new URL('../../../../evals/memory/stage3-retrieval-dev-v1.json', import.meta.url))

describe('memory multi-baseline evaluation', () => {
  it('compares six retrieval strategies on one frozen corpus', async () => {
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as MemoryMultiBaselineFixture
    const report = await runMemoryMultiBaselineEval(fixture, {
      topK: 5,
      noiseCount: 250,
      now: () => Date.UTC(2026, 8, 3),
    })

    console.info(JSON.stringify({
      stage: 'memory-multi-baseline-dev-eval',
      results: Object.fromEntries(MEMORY_MULTI_BASELINE_STRATEGIES.map(strategy => [strategy, {
        recallAtK: report.strategies[strategy].recallAtK,
        top1Accuracy: report.strategies[strategy].top1Accuracy,
        ndcgAtK: report.strategies[strategy].ndcgAtK,
        abstentionAccuracy: report.strategies[strategy].abstentionAccuracy,
        p95LatencyMilliseconds: report.strategies[strategy].p95LatencyMilliseconds,
        gatePassed: report.qualityGates[strategy].passed,
      }])),
    }))
    if (process.env.CONTINUUM_MEMORY_MULTI_BASELINE_REPORT_PATH)
      writeFileSync(process.env.CONTINUUM_MEMORY_MULTI_BASELINE_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')

    expect(Object.keys(report.strategies)).toEqual([...MEMORY_MULTI_BASELINE_STRATEGIES])
    expect(report).toMatchObject({ caseCount: 29, factCount: 22, noiseCount: 250 })
    expect(report.corpusItemCount).toBe(272)
    expect(report.strategies['no-memory']).toMatchObject({
      recallAtK: 0,
      top1Accuracy: 0,
      abstentionAccuracy: 1,
    })
    expect(report.strategies.oracle).toMatchObject({
      recallAtK: 1,
      top1Accuracy: 1,
      mrrAtK: 1,
      ndcgAtK: 1,
      abstentionAccuracy: 1,
    })
    expect(report.strategies['v3-hybrid-rrf'].recallAtK).toBeGreaterThanOrEqual(0.9)
    expect(report.qualityGates['v3-hybrid-rrf'].passed).toBe(true)
    for (const strategy of MEMORY_MULTI_BASELINE_STRATEGIES) {
      const gate = report.qualityGates[strategy]
      expect(gate.passed).toBe(gate.checks.every(check => check.passed))
    }
  }, 60_000)

  it('rejects invalid or ambiguous truth fixtures', async () => {
    const valid = JSON.parse(readFileSync(fixturePath, 'utf-8')) as MemoryMultiBaselineFixture
    const duplicateQuery = structuredClone(valid)
    duplicateQuery.cases[1]!.query = duplicateQuery.cases[0]!.query
    await expect(runMemoryMultiBaselineEval(duplicateQuery, { noiseCount: 0 })).rejects.toThrow(/Duplicate/u)

    const unknownTruth = structuredClone(valid)
    unknownTruth.cases[0]!.relevantKeys = ['missing.fact']
    await expect(runMemoryMultiBaselineEval(unknownTruth, { noiseCount: 0 })).rejects.toThrow(/unknown fact/u)
  })
})
