import type { Embedder } from '@continuum-memory/contracts'
import { CROSS_TOPIC_CASES, createCrossTopicFixture } from '../fixtures/cross-topic-recall'
import { createV4GraphMemory } from '../adapters/v4-graph-memory'
import { createMemoryEmbeddingIndex } from '../../long-term/embedding-index'
import { prepareEntityVectors } from '../recall/entity-vector-preparation'
import { prepareV4EntityVectors } from '../adapters/v4-entity-vector-preparation'
import type { RecallStageDiagnostic } from '../recall/recall-diagnostics'
import { measureRetrievalIndexScaling } from './retrieval-index-scaling'
import { createCrossEncoderSelection, type LocalCrossEncoder } from '../recall/cross-encoder-selection'

interface ComparisonRoute {
  id: string; retrievalMode: 'lexical' | 'vector' | 'hybrid' | 'entity-vector'; structuredRecall: boolean
  entityClaimCandidates?: 'threshold' | 'wide'; pairMode?: 'rank' | 'select'
  entityRetrievalTextMode?: 'name-only' | 'claim-fragments'
}

interface CaseResult {
  id: string; category: string; route: string; query: string; expected: string[]; actual: string[]
  qualityApplicable: boolean; qualityPassed: boolean; boundaryPassed: boolean; elapsedMs: number
  candidateCoverageApplicable: boolean; candidateCoveragePassed: boolean; candidateIds: readonly string[]
  missing: { id: string; stage: string }[]; unexpected: string[]; error: unknown
  stages: (RecallStageDiagnostic & { stageMs: number })[]; searchScope: readonly string[]; stopReason: string | null
  assessmentFailed: boolean
  pairScores: { elapsedMs: number; pairs: number; scores?: readonly { id: string; score: number }[]; error?: string }[]
}

export const COMPARISON_ROUTES = [
  { id: 'A-keyword', retrievalMode: 'lexical', structuredRecall: false },
  { id: 'B-vector', retrievalMode: 'vector', structuredRecall: false },
  { id: 'C-RRF', retrievalMode: 'hybrid', structuredRecall: false },
  { id: 'D-RRF-structured', retrievalMode: 'hybrid', structuredRecall: true },
  { id: 'E-entity-local', retrievalMode: 'entity-vector', structuredRecall: false, entityClaimCandidates: 'threshold' },
  { id: 'F-entity-wide-gated', retrievalMode: 'entity-vector', structuredRecall: false, entityClaimCandidates: 'wide' },
  { id: 'I-entity-fragments', retrievalMode: 'entity-vector', structuredRecall: false, entityClaimCandidates: 'wide', entityRetrievalTextMode: 'claim-fragments' },
] as const

/** First observed loss of gold evidence, not a guessed explanation from the final answer. */
export function evidenceGap(id: string, events: readonly RecallStageDiagnostic[]) {
  for (const stage of ['eligibility', 'entity-entry', 'retrieval', 'candidate-pool', 'selection', 'delivery'] as const) {
    const event = events.find(e => e.stage === stage)
    if (event && !event.factIds.includes(id)) return stage
  }
  return 'unobserved-or-error'
}

/** Fixed A-F controls, I uses source-checked entity fragments; optional G/H add pair inference. */
export async function compareCrossTopicModel(embedder: Embedder, pairModel?: { model: LocalCrossEncoder; drain: () => Promise<void>; minLogit: number }) {
  const allRoutes: readonly ComparisonRoute[] = [...COMPARISON_ROUTES, ...(pairModel ? [
    { id: 'G-pair-rank-gated', retrievalMode: 'entity-vector' as const, structuredRecall: false, entityClaimCandidates: 'wide' as const, pairMode: 'rank' as const },
    { id: 'H-pair-rank-select', retrievalMode: 'entity-vector' as const, structuredRecall: false, entityClaimCandidates: 'wide' as const, pairMode: 'select' as const },
  ] : [])]
  const vectors = new Map<string, number[]>(), pending = new Set<Promise<unknown>>()
  const embed = async (text: string) => {
    let vector = vectors.get(text)
    if (!vector) { vector = await embedder.embed(text); vectors.set(text, vector) }
    return vector
  }
  // Query inference is timed on every request; only document preparation is cached.
  const embedQuery = (text: string) => {
    const promise = embedder.embed(text).then(vector => ({ model: embedder.model, vector }))
    pending.add(promise); void promise.then(() => pending.delete(promise), () => pending.delete(promise)); return promise
  }
  const cases: CaseResult[] = [], preparationStart = performance.now()
  const prepared = []
  for (const c of CROSS_TOPIC_CASES) {
    const f = createCrossTopicFixture(c), facts = createMemoryEmbeddingIndex(), entities = createMemoryEmbeddingIndex()
    for (const fact of f.repository.snapshot().facts) facts.putBatch([{ memoryId: fact.id, content: fact.canonicalText,
      model: embedder.model, vector: await embed(fact.canonicalText) }])
    await prepareEntityVectors({ bundle: f.bundle, index: entities, model: embedder.model, embed, isCurrent: () => true })
    const fragments = createMemoryEmbeddingIndex()
    await prepareV4EntityVectors({ memory: f.options, scope: f.bundle.scope, sharePolicies: ['allow-remote'], sensitivities: ['normal'],
      index: fragments, model: embedder.model, embed, isCurrent: () => true })
    prepared.push({ c, facts, entities, fragments })
  }
  const preparationMs = performance.now() - preparationStart
  try {
    for (const { c, facts, entities, fragments } of prepared) {
      // Rotate route order to avoid always measuring one route first.
      const offset = CROSS_TOPIC_CASES.indexOf(c) % allRoutes.length
      const routes = [...allRoutes.slice(offset), ...allRoutes.slice(0, offset)]
      for (const route of routes) {
        await Promise.allSettled([...pending])
        await pairModel?.drain()
        const f = createCrossTopicFixture(c), events: RecallStageDiagnostic[] = []
        const pairScores: CaseResult['pairScores'] = []
        const pair = route.pairMode && pairModel ? createCrossEncoderSelection({ id: pairModel.model.id, score: async (query, candidates, signal) => {
          const start = performance.now()
          try { const scores = await pairModel.model.score(query, candidates, signal)
            pairScores.push({ pairs: candidates.length, elapsedMs: performance.now() - start, scores }); return scores
          } catch (error) { pairScores.push({ pairs: candidates.length, elapsedMs: performance.now() - start, error: String(error) }); throw error }
        } }, { minLogit: pairModel.minLogit }) : undefined
        const port = createV4GraphMemory({ ...f.options, ...route, candidateSelection: { candidateLimit: 64,
          ...(pair ? { reranker: pair.reranker, ...(route.pairMode === 'select' ? { evidenceSelector: pair.evidenceSelector } : {}) } : {}) }, entityCandidateLimit: 4,
          diagnostics: e => events.push(e),
          semantic: { model: embedder.model, dimensions: embedder.dimensions, index: facts, embedQuery },
          entitySemantic: { model: embedder.model, dimensions: embedder.dimensions,
            index: route.entityRetrievalTextMode === 'claim-fragments' ? fragments : entities, embedQuery } })
        const start = performance.now(), result = await port.recall(f.request), elapsedMs = performance.now() - start
        await pairModel?.drain()
        pair?.clear()
        const claims = result.ok ? result.value.evidence.claims.filter(claim => claim.kind === 'direct') : []
        const actual = claims.map(claim => claim.fact.id).sort(), expected = [...c.expected].sort()
        const assessmentFailed = result.ok && result.value.trace.searchScope.some(s =>
          ['evidence-assessment:failed-or-timeout-abstain', 'evidence-assessment:budget-skipped', 'reranker:failed-or-timeout-original-order', 'reranker:budget-skipped'].includes(s))
        const qualityPassed = !c.denied && !assessmentFailed && result.ok && JSON.stringify(actual) === JSON.stringify(expected)
        // Failure to answer is a quality/runtime failure, not by itself an evidence leak.
        const boundaryPassed = c.denied ? !result.ok && result.error.code === 'scope-denied' && events.length === 0 : claims.every(claim => {
          const fact = f.repository.snapshot().facts.find(fact => fact.id === claim.fact.id)
          return fact?.sensitivity === 'normal' && fact.sharePolicy === 'allow-remote'
            && claim.polarity === fact.polarity && claim.sources.every(source => {
              const ep = f.repository.snapshot().episodes.find(ep => ep.id === source.episodeId)
              return ep?.contentState !== 'deleted' && ep?.sharePolicy === 'allow-remote' && ep?.contentHash === source.contentHash
            }) && (c.mutation !== 'revoke' || fact.id !== 'tea')
            && (c.mutation !== 'missing-time' || fact.id !== 'tea')
            && (c.mutation === 'past' ? fact.id !== 'city' : fact.id !== 'old-city')
            && (fact.id !== 'tea' || claim.fact.version === (c.mutation === 'update' ? 2 : 1))
        })
        const candidateIds = events.find(e => e.stage === 'candidate-pool')?.factIds ?? []
        cases.push({ id: c.id, category: c.category, route: route.id, query: c.query, expected, actual,
          assessmentFailed, pairScores,
          candidateIds, candidateCoverageApplicable: expected.length > 0 && !c.denied && c.finalLimit === undefined,
          candidateCoveragePassed: result.ok && expected.every(id => candidateIds.includes(id)),
          qualityApplicable: !c.denied && c.finalLimit === undefined, qualityPassed, boundaryPassed, elapsedMs,
          missing: expected.filter(id => !actual.includes(id)).map(id => ({ id, stage: evidenceGap(id, events) })),
          unexpected: actual.filter(id => !expected.includes(id)), error: result.ok ? null : result.error,
          stages: events.map((e, i) => ({ ...e, stageMs: e.elapsedMs - (events[i - 1]?.elapsedMs ?? 0) })),
          searchScope: result.ok ? result.value.trace.searchScope : [], stopReason: result.ok ? result.value.trace.stopReason : null })
      }
    }
  } finally { await Promise.allSettled([...pending]); await pairModel?.drain() }
  const scalingQuery = '我喜欢喝什么', scalingVector = await embedder.embed(scalingQuery)
  const indexScaling = measureRetrievalIndexScaling([...vectors].map(([text, vector]) => ({ text, vector })), scalingQuery, scalingVector)
  return { schema: 'cross-topic-recall/v4', model: embedder.model, dimensions: embedder.dimensions, preparationMs, indexScaling,
    corpus: 'synthetic-explicit-native-claims-not-human-reviewed', candidateLimit: 64, entityCandidateLimit: 4,
    pairModel: pairModel ? { id: pairModel.model.id, minLogit: pairModel.minLogit, calibrated: false, timeoutMs: 300 } : null,
    routes: allRoutes.map(route => { const rows = cases.filter(c => c.route === route.id), quality = rows.filter(c => c.qualityApplicable)
      return { ...route, tests: rows.length, qualityTests: quality.length, exactEvidenceMatches: quality.filter(c => c.qualityPassed).length,
        candidateCoverageTests: rows.filter(c => c.candidateCoverageApplicable).length,
        candidateCoveragePassed: rows.filter(c => c.candidateCoverageApplicable && c.candidateCoveragePassed).length,
        unexpectedEvidenceCases: quality.filter(c => c.unexpected.length).length,
        assessmentFailures: rows.filter(c => c.assessmentFailed).length,
        boundaryPassed: rows.filter(c => c.boundaryPassed).length, errors: rows.filter(c => c.error && c.id !== 'owner').length } }),
    cases, limitations: ['Exact evidence set match is not generated-answer accuracy.', 'Synthetic labels need independent human review before threshold calibration.',
      'One warm-model run per query; timings are diagnostic, not a statistical speed comparison.',
      'Entity and fact vector indexes use exact flat search; authorized projection preparation can still scan records.',
      'Limited-output and denied-owner cases are separate from quality totals. No thresholds were tuned on these cases.',
      'L1 entry comparison only. L2 traversal is covered by separate regression checks, not measured by this corpus.'] }
}
