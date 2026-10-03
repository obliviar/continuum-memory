import type { Embedder } from '@continuum-memory/contracts'
import { createMemoryEmbeddingIndex } from '../../long-term/embedding-index'
import { DIRECT_SEMANTIC_MIN_COSINE } from '../recall/direct-semantic'
import { runDirectRecallRegression } from './direct-recall-regression'
import { runDirectStructuredRegression } from './direct-structured-regression'
import type { MemoryV4Snapshot } from '../../v4/domain/types'

type RecallReport = Awaited<ReturnType<typeof runDirectRecallRegression>>
function summarize(report: RecallReport) {
  const times = report.cases.map(row => row.elapsedMs).sort((a, b) => a - b)
  return {
    tests: report.tests, exactMatches: report.qualityPassed,
    missingQuestions: report.cases.filter(row => row.missing.length).length,
    extraQuestions: report.cases.filter(row => row.unexpected.length).length,
    boundaryFailures: report.cases.filter(row => !row.boundaryPassed || !row.evidencePassed).map(row => row.id),
    noAnswerFalsePositives: report.cases.filter(row => !row.expected.length && row.actual.length).map(row => row.id),
    semanticUsed: report.cases.filter(row => row.searchScope.includes('semantic:ready') || row.searchScope.includes('semantic:partial')).length,
    semanticDegraded: report.cases.filter(row => row.searchScope.some(s => /^semantic:(query-|empty-index|budget-skipped|invalid-config|partial)/.test(s))).length,
    latencyMs: { p50: times[Math.ceil(times.length * 0.5) - 1]!, p95: times[Math.ceil(times.length * 0.95) - 1]! },
  }
}

/** Uses only the fixed synthetic corpus, never the user's encrypted memory database. */
export async function compareDirectRecallModel(embedder: Embedder, options: {
  thresholds?: readonly number[]
  onProgress?: (message: string) => void
} = {}) {
  const thresholds = [...new Set(options.thresholds ?? [0.7, 0.75, DIRECT_SEMANTIC_MIN_COSINE, 0.85])]
  if (!thresholds.length || thresholds.some(t => !Number.isFinite(t) || t <= 0 || t > 1)
    || !thresholds.includes(DIRECT_SEMANTIC_MIN_COSINE))
    throw new Error('Thresholds must be in (0, 1] and include the production default')
  const baseline = await runDirectRecallRegression({ structuredRecall: false })
  const structuredBaseline = await runDirectRecallRegression()
  const factVectors = new Map<string, number[]>()
  const pending = new Set<Promise<unknown>>()
  const drain = () => Promise.allSettled([...pending])
  let factEmbeddingMs = 0
  const trials = []
  const prepareSemantic = async (snapshot: MemoryV4Snapshot, minCosine: number) => {
    await drain()
    const index = createMemoryEmbeddingIndex()
    for (const fact of snapshot.facts) {
      let vector = factVectors.get(fact.canonicalText)
      if (!vector) {
        const start = performance.now()
        vector = await embedder.embed(fact.canonicalText)
        factEmbeddingMs += performance.now() - start
        factVectors.set(fact.canonicalText, vector)
      }
      index.putBatch([{ memoryId: fact.id, model: embedder.model, content: fact.canonicalText, vector }])
    }
    return { model: embedder.model, dimensions: embedder.dimensions, index, minCosine,
      embedQuery: (query: string) => {
        // Live queries retain the production timeout; drain timed-out operations before the next case.
        const operation = Promise.resolve().then(() => embedder.embed(query))
          .then(vector => ({ model: embedder.model, vector }))
        pending.add(operation)
        void operation.then(() => pending.delete(operation), () => pending.delete(operation))
        return operation
      } }
  }
  const run = (minCosine: number, structuredRecall: boolean) => runDirectRecallRegression({ structuredRecall,
    prepareSemantic: snapshot => prepareSemantic(snapshot, minCosine) })
  let vectorOnlyControl: RecallReport
  let structuredChecks: Awaited<ReturnType<typeof runDirectStructuredRegression>>
  try {
    options.onProgress?.('Evaluating keyword + vector control (structured route disabled)')
    vectorOnlyControl = await run(DIRECT_SEMANTIC_MIN_COSINE, false)
    for (const minCosine of thresholds) {
      options.onProgress?.(`Evaluating cosine >= ${minCosine}`)
      const report = await run(minCosine, true)
      const comparison = report.cases.map((row, i) => {
        const old = baseline.cases[i]!
        if (old.id !== row.id || JSON.stringify(old.expected) !== JSON.stringify(row.expected))
          throw new Error('Comparison requires identical questions and gold evidence')
        return { id: row.id, query: row.query, expected: row.expected,
          lexical: { actual: old.actual, elapsedMs: old.elapsedMs },
          hybrid: { actual: row.actual, elapsedMs: row.elapsedMs, preparationMs: row.preparationMs,
            missing: row.missing, unexpected: row.unexpected, outcome: row.outcome,
            searchScope: row.searchScope, completeness: row.completeness },
          change: !old.qualityPassed && row.qualityPassed ? 'improved'
            : old.qualityPassed && !row.qualityPassed ? 'regressed' : 'unchanged' }
      })
      trials.push({ minCosine, structuredRecall: true, summary: summarize(report), comparison })
    }
    options.onProgress?.('Checking structured paraphrases and boundaries with the same local provider')
    structuredChecks = await runDirectStructuredRegression(snapshot => prepareSemantic(snapshot, DIRECT_SEMANTIC_MIN_COSINE))
  } finally { await drain() }
  const current = trials.find(trial => trial.minCosine === DIRECT_SEMANTIC_MIN_COSINE)!
  return {
    schema: 'direct-model-comparison/v1', status: 'completed', corpus: 'synthetic-not-human-reviewed',
    model: embedder.model, dimensions: embedder.dimensions,
    timing: 'warm-model; prepared-fact-vectors; live-query-embedding; initialization-excluded; single-pass',
    factPreparation: { uniqueTexts: factVectors.size, embeddingMs: factEmbeddingMs },
    baseline: { summary: summarize(baseline), cases: baseline.cases }, trials,
    structuredBaseline: { summary: summarize(structuredBaseline), cases: structuredBaseline.cases },
    structuredChecks,
    vectorOnlyControl: { minCosine: DIRECT_SEMANTIC_MIN_COSINE, structuredRecall: false,
      summary: summarize(vectorOnlyControl), cases: vectorOnlyControl.cases },
    productionThreshold: DIRECT_SEMANTIC_MIN_COSINE,
    qualityGatePassed: current.summary.exactMatches === current.summary.tests
      && current.summary.semanticUsed > 0 && current.summary.semanticDegraded === 0
      && structuredChecks.checks.every(check => check.passed),
    limitation: 'Small synthetic development set; no held-out quality claim. Trials include the structured route; use the controls to attribute gains. Thresholds are unchanged.',
  }
}
