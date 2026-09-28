import type { GraphRecallRequest } from '@continuum-memory/contracts'
import { createMemoryEmbeddingIndex } from '../../long-term/embedding-index'
import { createV4GraphTestRepository, V4_TEST_SCOPE as scope } from '../fixtures/v4-direct-memory'
import { createV4GraphMemory, V4_GRAPH_BUDGET } from '../adapters/v4-graph-memory'
import { mergeDirectCandidates, type DirectSemanticOptions } from '../recall/direct-semantic'

// Explicit toy vectors test wiring and boundaries, NOT learned-model retrieval quality.
type Mutable<T> = { -readonly [K in keyof T]: T[K] extends object ? Mutable<T[K]> : T[K] }
function setup() {
  const repository = createV4GraphTestRepository()
  const cache = createMemoryEmbeddingIndex()
  cache.putBatch([{ memoryId: 'f', model: 'test-model', content: 'I like tea', vector: [1, 0] }])
  const lookups: string[] = []
  let queries = 0
  let allow = true
  let authorize = true
  const semantic: DirectSemanticOptions = { model: 'test-model', dimensions: 2,
    index: { get: (id, model, text) => { lookups.push(id); return cache.get(id, model, text) } },
    embedQuery: async () => { queries++; return { model: 'test-model', vector: [1, 0] } } }
  const request: Mutable<GraphRecallRequest> = { protocolVersion: 'memory-graph/v1', recallId: 'hybrid',
    query: '偏爱的饮品是哪种', scope, mode: 'direct-only',
    temporal: { knownAt: 200, valid: { kind: 'at', at: 200 } }, budget: { ...V4_GRAPH_BUDGET },
    sharePolicies: ['local-only'], sensitivities: ['normal'] }
  let checkpoint: string | undefined
  const options = { repository, persistence: { load: () => checkpoint, save: (payload: string) => { checkpoint = payload } },
    authorizeScope: (s: typeof scope) => authorize && s.ownerId === scope.ownerId && s.agentId === scope.agentId,
    canRead: () => allow, countTokens: (s: string) => Buffer.byteLength(s), now: () => 200, semantic }
  return { repository, cache, semantic, options, request, lookups, queries: () => queries,
    deny: () => { allow = false }, revoke: () => { authorize = false } }
}
type Fixture = ReturnType<typeof setup>
interface Scenario {
  id: string
  arrange?: (f: Fixture) => void
  expected?: string[]
  error?: string
  status?: string
  incomplete?: boolean
  noLookup?: boolean
}
const scenarios: Scenario[] = [
  { id: 'semantic-only-candidate', expected: ['f'], status: 'ready' },
  { id: 'deduplicate-both-channels', arrange: f => { f.request.query = 'like tea' }, expected: ['f'] },
  { id: 'below-threshold-abstains', arrange: f => {
    f.semantic.embedQuery = async () => ({ model: 'test-model', vector: [0.6, 0.8] })
  }, expected: [] },
  { id: 'no-vector-fallback', arrange: f => { f.cache.removeMemoryIds(['f']); f.request.query = 'tea' },
    expected: ['f'], status: 'empty-index', incomplete: true },
  { id: 'disabled-provider-fallback', arrange: f => {
    f.request.query = 'tea'; f.semantic.embedQuery = async () => undefined
  }, expected: ['f'], status: 'query-unavailable', incomplete: true },
  { id: 'invalid-cache-vector-skipped', arrange: f => {
    f.request.query = 'tea'; f.semantic.index = { get: () => [0, 0] }
  }, expected: ['f'], status: 'empty-index', incomplete: true },
  { id: 'wrong-cache-model-skipped', arrange: f => {
    f.cache.removeMemoryIds(['f'])
    f.cache.putBatch([{ memoryId: 'f', model: 'other-model', content: 'I like tea', vector: [1, 0] }])
    f.request.query = 'tea'
  }, expected: ['f'], status: 'empty-index', incomplete: true },
  { id: 'partial-cache-is-visible', arrange: f => {
    f.repository.transaction(s => {
      s.evidenceLinks.push({ ...s.evidenceLinks[0]!, id: 'ev2', factId: 'f2' })
      s.facts.push({ ...s.facts[0]!, id: 'f2', evidenceLinkIds: ['ev2'] })
      s.factVersions.push({ ...s.factVersions[0]!, id: 'v-f2', factId: 'f2', evidenceLinkIds: ['ev2'] })
    })
  }, expected: ['f'], status: 'partial', incomplete: true },
  { id: 'changed-text-rejects-old-cache', arrange: f => {
    f.repository.transaction(s => {
      const old = s.factVersions[0]!, fact = s.facts[0]!
      old.transactionClosedAt = 150
      Object.assign(fact, { canonicalText: 'I like coffee', object: 'coffee', normalizedValue: 'coffee', updatedAt: 150 })
      s.episodes[0]!.content = 'I like coffee'
      s.factVersions.push({ ...old, id: 'v2', version: 2, recordedAt: 150, transactionClosedAt: undefined,
        canonicalText: fact.canonicalText, object: fact.object, normalizedValue: fact.normalizedValue })
    })
  }, expected: [], status: 'empty-index', incomplete: true },
  { id: 'wrong-model-fallback', arrange: f => {
    f.request.query = 'tea'; f.semantic.embedQuery = async () => ({ model: 'other-model', vector: [1, 0] })
  }, expected: ['f'], status: 'query-unavailable', incomplete: true },
  { id: 'wrong-dimension-fallback', arrange: f => {
    f.request.query = 'tea'; f.semantic.embedQuery = async () => ({ model: 'test-model', vector: [1, 0, 0] })
  }, expected: ['f'], status: 'query-unavailable', incomplete: true },
  { id: 'invalid-vector-fallback', arrange: f => {
    f.request.query = 'tea'; f.semantic.embedQuery = async () => ({ model: 'test-model', vector: [NaN, 0] })
  }, expected: ['f'], status: 'query-unavailable', incomplete: true },
  { id: 'non-unit-vector-fallback', arrange: f => {
    f.request.query = 'tea'; f.semantic.embedQuery = async () => ({ model: 'test-model', vector: [10, 0] })
  }, expected: ['f'], status: 'query-unavailable', incomplete: true },
  { id: 'query-failure-fallback', arrange: f => {
    f.request.query = 'tea'; f.semantic.embedQuery = async () => { throw new Error('test failure') }
  }, expected: ['f'], status: 'query-or-index-failed', incomplete: true },
  { id: 'query-timeout-fallback', arrange: f => {
    f.request.query = 'tea'; f.semantic.timeoutMs = 5; f.semantic.embedQuery = () => new Promise(() => {})
  }, expected: ['f'], status: 'query-timeout', incomplete: true },
  { id: 'deleted-source-before-search', arrange: f => {
    f.repository.transaction(s => { s.episodes[0]!.contentState = 'deleted'; s.episodes[0]!.deletedAt = 150; delete s.episodes[0]!.content })
  }, expected: [], noLookup: true },
  { id: 'denied-source-before-search', arrange: f => { f.deny() }, expected: [], noLookup: true },
  { id: 'owner-isolation', arrange: f => { f.request.scope = { ...scope, ownerId: 'other' } }, error: 'scope-denied', noLookup: true },
  { id: 'agent-isolation', arrange: f => { f.request.scope = { ...scope, agentId: 'other' } }, error: 'scope-denied', noLookup: true },
  { id: 'session-isolation', arrange: f => { f.request.scope = { ...scope, sessionId: 'other' } }, expected: [], noLookup: true },
  { id: 'share-policy-filter', arrange: f => { f.request.sharePolicies = ['allow-remote'] }, expected: [], noLookup: true },
  { id: 'sensitivity-filter', arrange: f => { f.request.sensitivities = ['private'] }, expected: [], noLookup: true },
  { id: 'time-filter', arrange: f => { f.request.temporal.valid = { kind: 'at', at: 50 } }, expected: [], noLookup: true },
  { id: 'source-deleted-during-query', arrange: f => {
    f.semantic.embedQuery = async () => {
      f.repository.transaction(s => { s.episodes[0]!.contentState = 'deleted'; s.episodes[0]!.deletedAt = 150; delete s.episodes[0]!.content })
      return { model: 'test-model', vector: [1, 0] }
    }
  }, error: 'stale-projection' },
  { id: 'permission-revoked-during-query', arrange: f => {
    f.semantic.embedQuery = async () => { f.deny(); return { model: 'test-model', vector: [1, 0] } }
  }, error: 'stale-projection' },
  { id: 'authorization-revoked-during-query', arrange: f => {
    f.semantic.embedQuery = async () => { f.revoke(); return { model: 'test-model', vector: [1, 0] } }
  }, error: 'stale-projection' },
  { id: 'evidence-budget-still-applies', arrange: f => { f.request.budget.maxEvidenceTokens = 1 }, expected: [], incomplete: true },
  { id: 'node-budget-still-applies', arrange: f => { f.request.budget.maxNodes = 0 }, expected: [], incomplete: true },
  { id: 'elapsed-budget-still-applies', arrange: f => { f.request.budget.maxElapsedMs = 0 }, error: 'budget-exhausted' },
]

export async function runDirectHybridRegression() {
  const checks = []
  for (const scenario of scenarios) {
    const f = setup()
    scenario.arrange?.(f)
    const result = await createV4GraphMemory(f.options).recall(f.request)
    const actual = result.ok ? result.value.evidence.claims.map(c => c.kind === 'direct' ? c.fact.id : 'not-direct') : []
    const error = result.ok ? null : result.error.code
    const trace = result.ok ? result.value.trace : undefined
    const passed = (scenario.error ? error === scenario.error : result.ok && JSON.stringify(actual) === JSON.stringify(scenario.expected))
      && (!scenario.status || !!trace?.searchScope.includes(`semantic:${scenario.status}`))
      && (!scenario.incomplete || trace?.completeness === 'incomplete')
      && (!scenario.noLookup || (f.lookups.length === 0 && f.queries() === 0))
      && (!result.ok || result.value.evidence.claims.every(c => c.kind === 'direct' && c.sources[0]?.episodeId === 'ep'
        && c.fact.version === 1 && c.support === 'unknown'))
    checks.push({ id: scenario.id, passed, actual, error, searchScope: trace?.searchScope })
  }
  const merged = mergeDirectCandidates([{ id: 'a', score: 100 }, { id: 'b', score: 1 }],
    [{ id: 'b', score: 0.99 }, { id: 'c', score: 0.9 }])
  checks.push({ id: 'rrf-keeps-both-entrances-and-prefers-agreement', passed: merged.map(h => h.id).join() === 'b,a,c',
    actual: merged.map(h => h.id), error: null, searchScope: undefined })
  return { kind: 'synthetic-vector-integration-not-model-quality', checks }
}
