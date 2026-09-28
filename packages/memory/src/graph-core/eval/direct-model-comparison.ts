import type { Embedder } from '@continuum-memory/contracts'
import { createMemoryEmbeddingIndex } from '../../long-term/embedding-index'
import { DIRECT_SEMANTIC_MIN_COSINE } from '../recall/direct-semantic'
import { runDirectRecallRegression } from './direct-recall-regression'

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
  const baseline = await runDirectRecallRegression()
  const factVectors = new Map<string, number[]>()
  const pending = new Set<Promise<unknown>>()
  const drain = () => Promise.allSettled([...pending])
  let factEmbeddingMs = 0
  const trials = []
  try {
    for (const minCosine of thresholds) {
      options.onProgress?.(`Evaluating cosine >= ${minCosine}`)
      const report = await runDirectRecallRegression({ prepareSemantic: async snapshot => {
        // A timed-out inference must finish before the next trial; no overlapped timing samples.
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
          embedQuery: query => {
            // Query vectors are deliberately not cached: exercise the runtime timeout as well.
            const operation = Promise.resolve().then(() => embedder.embed(query))
              .then(vector => ({ model: embedder.model, vector }))
            pending.add(operation)
            void operation.then(() => pending.delete(operation), () => pending.delete(operation))
            return operation
          } }
      } })
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
      trials.push({ minCosine, summary: summarize(report), comparison })
    }
  } finally { await drain() }
  const current = trials.find(trial => trial.minCosine === DIRECT_SEMANTIC_MIN_COSINE)!
  return {
    schema: 'direct-model-comparison/v1', status: 'completed', corpus: 'synthetic-not-human-reviewed',
    model: embedder.model, dimensions: embedder.dimensions,
    timing: 'warm-model; prepared-fact-vectors; live-query-embedding; initialization-excluded; single-pass',
    factPreparation: { uniqueTexts: factVectors.size, embeddingMs: factEmbeddingMs },
    baseline: { summary: summarize(baseline), cases: baseline.cases }, trials,
    productionThreshold: DIRECT_SEMANTIC_MIN_COSINE,
    qualityGatePassed: current.summary.exactMatches === current.summary.tests
      && current.summary.semanticUsed > 0 && current.summary.semanticDegraded === 0,
    limitation: 'Small synthetic development set; threshold sweep is exploratory, not held-out validation. Production settings are unchanged.',
  }
}
