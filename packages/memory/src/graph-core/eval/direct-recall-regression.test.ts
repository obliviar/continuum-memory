import { beforeAll, describe, expect, it } from 'vitest'
import { runDirectRecallRegression } from './direct-recall-regression'

describe('direct recall evidence regression v1', () => {
  let report: Awaited<ReturnType<typeof runDirectRecallRegression>>
  beforeAll(async () => { report = await runDirectRecallRegression() })
  it('preserves evidence integrity, source deletion, unknown time and access boundaries', () => {
    expect(report.tests).toBe(12)
    expect(report.lexicalChecks.every(row => row.passed)).toBe(true)
    for (const row of report.cases) {
      expect(row.boundaryPassed, row.id).toBe(true)
      expect(row.evidencePassed, row.id).toBe(true)
      expect(row.qualityPassed, row.id).toBe(true)
    }
    console.info(JSON.stringify({ cases: report.tests, exactEvidenceMatches: report.qualityPassed,
      failures: report.cases.filter(row => !row.qualityPassed).map(row => ({ id: row.id, missing: row.missing, unexpected: row.unexpected })) }))
  })
  // Keep ideal labels unchanged. Enable this strict quality gate when comparing retrieval changes.
  it.runIf(process.env.GRAPH_RECALL_STRICT === '1')('matches every gold evidence set (quality gate)', () => {
    expect(report.cases.filter(row => !row.qualityPassed)).toEqual([])
  })
})
