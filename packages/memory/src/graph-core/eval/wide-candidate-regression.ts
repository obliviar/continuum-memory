import assert from 'node:assert/strict'
import { selectRecallCandidates } from '../recall/candidate-selection'
import { CROSS_TOPIC_CASES, createCrossTopicFixture } from '../fixtures/cross-topic-recall'
import { createV4GraphMemory } from '../adapters/v4-graph-memory'
import { createV4L2Memory } from '../adapters/v4-l2-memory'
import { createMemoryEmbeddingIndex } from '../../long-term/embedding-index'
import { prepareEntityVectors } from '../recall/entity-vector-preparation'
import { createNativeL2Fixture } from './native-l2-regression'
import type { GraphSemanticBundle } from '../domain/types'
import type { V4GraphMemoryOptions } from '../adapters/v4-graph-memory'
import type { RecallStageDiagnostic } from '../recall/recall-diagnostics'

async function belowThreshold(options: V4GraphMemoryOptions, bundle: GraphSemanticBundle) {
  const index = createMemoryEmbeddingIndex(), entityIndex = createMemoryEmbeddingIndex(), model = 'toy-wide-candidates'
  for (const f of options.repository.snapshot().facts) index.putBatch([{ memoryId: f.id, model, content: f.canonicalText, vector: [0.7, Math.sqrt(0.51)] }])
  await prepareEntityVectors({ bundle, index: entityIndex, model, embed: async () => [1, 0], isCurrent: () => true })
  const embedQuery = async () => ({ model, vector: [1, 0] })
  return { retrievalMode: 'entity-vector' as const, entityClaimCandidates: 'wide' as const,
    semantic: { model, dimensions: 2, index, embedQuery }, entitySemantic: { model, dimensions: 2, index: entityIndex, embedQuery } }
}

/** Controlled vectors/assessors exercise the wiring, not learned semantic quality. */
export async function runWideCandidateRegression() {
  const checks: { id: string; passed: boolean; error?: string }[] = []
  const test = async (id: string, run: () => unknown | Promise<unknown>) => {
    try { await run(); checks.push({ id, passed: true }) } catch (e) { checks.push({ id, passed: false, error: String(e) }) }
  }
  const input = { query: 'q', hits: [{ id: 'high', score: 0.9 }, { id: 'low', score: 0.7 }], text: (id: string) => id,
    finalLimit: 2, remainingMs: 1000, admissibleIds: new Set(['high']) }
  await test('wide-pool-does-not-become-evidence-by-itself', async () => {
    const r = await selectRecallCandidates(input)
    assert.equal(r.candidates.length, 2); assert.deepEqual(r.selected.map(c => c.id), ['high'])
    assert(r.assessmentIncomplete); assert(!r.truncated)
  })
  await test('reranker-scores-cannot-bypass-original-admission', async () => {
    const r = await selectRecallCandidates({ ...input, options: { reranker: { id: 'mock', rank: async () => [{ id: 'low', score: 100 }, { id: 'high', score: 0 }] } } })
    assert.deepEqual(r.selected.map(c => c.id), ['high'])
  })
  await test('explicit-evidence-assessor-can-admit-low-candidate', async () => {
    const r = await selectRecallCandidates({ ...input, options: { evidenceSelector: { id: 'mock', select: async () => ({ status: 'accepted', ids: ['low'] }) } } })
    assert.deepEqual(r.selected.map(c => c.id), ['low'])
  })
  for (const status of ['insufficient', 'ambiguous'] as const) await test(`assessor-${status}-returns-no-evidence`, async () => {
    const r = await selectRecallCandidates({ ...input, options: { evidenceSelector: { id: 'mock', select: async () => ({ status, ids: [] }) } } })
    assert.equal(r.selected.length, 0); assert(r.scope.includes(`evidence-assessment:${status}:mock`))
  })
  await test('assessor-cannot-introduce-foreign-ids', async () => {
    const r = await selectRecallCandidates({ ...input, options: { evidenceSelector: { id: 'mock', select: async () => ({ status: 'accepted', ids: ['foreign'] }) } } })
    assert.equal(r.selected.length, 0); assert(r.scope.includes('evidence-assessment:failed-or-timeout-abstain'))
  })
  await test('assessor-timeout-abstains-instead-of-returning-top-candidate', async () => {
    let signal: AbortSignal | undefined
    const r = await selectRecallCandidates({ ...input, options: { timeoutMs: 5, evidenceSelector: { id: 'mock', select: args => {
      signal = args.signal; return new Promise(() => {})
    } } } })
    assert(signal?.aborted); assert.equal(r.selected.length, 0)
  })
  await test('L1-wide-pool-covers-low-candidates-without-auto-output', async () => {
    const f = createCrossTopicFixture(CROSS_TOPIC_CASES.find(c => c.id === 'job-rewrite')!), events: RecallStageDiagnostic[] = []
    const semantic = await belowThreshold(f.options, f.bundle)
    const r = await createV4GraphMemory({ ...f.options, ...semantic, diagnostics: e => events.push(e) }).recall(f.request)
    assert(r.ok); assert.equal(r.value.evidence.claims.length, 0)
    assert(events.find(e => e.stage === 'candidate-pool')!.factIds.includes('job'))
    assert(!events.find(e => e.stage === 'candidate-pool')!.factIds.includes('private'))
    assert(!events.find(e => e.stage === 'candidate-pool')!.factIds.includes('old-city'))
    const selected = await createV4GraphMemory({ ...f.options, ...semantic, candidateSelection: { evidenceSelector: {
      id: 'mock-only', select: async () => ({ status: 'accepted', ids: ['job'] }),
    } } }).recall({ ...f.request, recallId: 'selected' })
    assert(selected.ok); assert.deepEqual(selected.value.evidence.claims.filter(c => c.kind === 'direct').map(c => c.fact.id), ['job'])
  })
  await test('L2-wide-assessed-candidate-reaches-local-traversal', async () => {
    const f = await createNativeL2Fixture(); assert((await f.publish()).ok)
    const semantic = await belowThreshold(f.options, f.projection.snapshot()!.semanticBundle)
    const r = await createV4L2Memory({ ...f.options, ...semantic, candidateSelection: { evidenceSelector: {
      id: 'mock-only', select: async ({ candidates }) => ({ status: 'accepted', ids: candidates.map(c => c.id) }),
    } } }).recall({ ...f.request, query: 'Which memories are related to Acme?' })
    assert(r.ok, r.ok ? undefined : r.error.message); assert.equal(r.value.evidence.claims.length, 2)
    assert.equal(r.value.evidence.relations?.length, 1)
    assert(r.value.trace.searchScope.includes('claim-candidates:wide'))
  })
  await test('assessor-cannot-bypass-source-deletion-during-review', async () => {
    const f = createCrossTopicFixture(CROSS_TOPIC_CASES[0]!), semantic = await belowThreshold(f.options, f.bundle)
    const r = await createV4GraphMemory({ ...f.options, ...semantic, candidateSelection: { evidenceSelector: {
      id: 'mutating', select: async () => {
        f.repository.transaction(s => { const ep = s.episodes.find(e => e.id === 'ep-tea')!; ep.deletedAt = 150; ep.contentState = 'deleted'; delete ep.content })
        return { status: 'accepted', ids: ['tea'] }
      },
    } } }).recall(f.request)
    assert(!r.ok); assert.equal(r.error.code, 'stale-projection')
  })
  return { checks }
}
