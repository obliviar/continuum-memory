import { compareDirectRecallModel } from './direct-model-comparison'

/** Tests the measurement harness with toy vectors, never reports these as model quality. */
export async function runDirectModelHarnessRegression() {
  const embedder = { model: 'test-harness-only', dimensions: 4,
    embed: async (text: string) => {
      const axis = /牛奶/.test(text) ? 1 : /杭州/.test(text) ? 2 : /宠物/.test(text) ? 3 : 0
      return Array.from({ length: 4 }, (_, i) => Number(i === axis))
    } }
  const report = await compareDirectRecallModel(embedder, { thresholds: [0.8, 0.85] })
  const checks = [
    { id: 'baseline-labels-and-count-preserved', passed: report.baseline.summary.exactMatches === 11
      && report.baseline.summary.tests === 12 },
    { id: 'structured-gain-is-separated-from-vector-gain', passed: report.structuredBaseline.summary.exactMatches === 12
      && report.vectorOnlyControl.structuredRecall === false && report.vectorOnlyControl.summary.exactMatches === 12 },
    { id: 'paired-comparison-with-fixed-gold', passed: report.trials.length === 2 && report.trials.every(t =>
      t.summary.exactMatches === 12 && t.comparison.length === 12
      && t.comparison.find(c => c.id === 'semantic-rewrite')?.change === 'improved') },
    { id: 'query-time-and-route-recorded', passed: report.trials.every(t => t.summary.semanticUsed > 0
      && t.summary.semanticDegraded === 0 && t.comparison.every(c => Number.isFinite(c.hybrid.elapsedMs))) },
    { id: 'successful-harness-quality-gate', passed: report.qualityGatePassed },
  ]
  const degraded = await compareDirectRecallModel({ ...embedder, embed: async () => [NaN, 0, 0, 0] }, { thresholds: [0.8] })
    .then(() => false, () => true)
  checks.push({ id: 'failed-fact-embedding-is-not-a-valid-comparison', passed: degraded })
  const unavailable = await compareDirectRecallModel({ ...embedder, embed: async text => {
    if (!text.startsWith('用户')) throw new Error('test query unavailable')
    return embedder.embed(text)
  } }, { thresholds: [0.8] })
  checks.push({ id: 'fallback-does-not-pass-model-quality-gate', passed: !unavailable.qualityGatePassed
    && unavailable.trials[0]!.summary.semanticDegraded > 0 })
  return { kind: 'measurement-harness-test-not-real-model-quality', checks }
}
