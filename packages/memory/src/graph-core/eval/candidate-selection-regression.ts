import assert from 'node:assert/strict'
import { selectRecallCandidates } from '../recall/candidate-selection'
import { emitRecallDiagnostic, type RecallStageDiagnostic } from '../recall/recall-diagnostics'
import { createV4GraphMemory } from '../adapters/v4-graph-memory'
import { createV4L2Memory } from '../adapters/v4-l2-memory'
import { CROSS_TOPIC_CASES, createCrossTopicFixture } from '../fixtures/cross-topic-recall'
import { collectCurrentL1 } from '../adapters/accepted-l1-input'
import { evidenceGap } from './cross-topic-comparison'
import { createNativeL2Fixture } from './native-l2-regression'
import { graphHash } from '../adapters/v4-semantic-adapter'

export async function runCandidateSelectionRegression() {
  const checks: { id: string; passed: boolean; error?: string }[] = []
  const test = async (id: string, run: () => unknown | Promise<unknown>) => {
    try { await run(); checks.push({ id, passed: true }) } catch (e) { checks.push({ id, passed: false, error: String(e) }) }
  }
  const input = { query: 'test', hits: [{ id: 'a', score: 0.9 }, { id: 'b', score: 0.8 }, { id: 'c', score: 0.7 }],
    text: (id: string) => id, finalLimit: 1, remainingMs: 1000 }
  await test('candidate-pool-independent-of-final-selection', async () => {
    const r = await selectRecallCandidates(input)
    assert.equal(r.candidates.length, 3); assert.deepEqual(r.selected, input.hits.slice(0, 1)); assert(r.truncated)
    assert(r.scope.includes('reranker:disabled'))
  })
  await test('pool-cap-and-dedup-preserve-order', async () => {
    const r = await selectRecallCandidates({ ...input, hits: [...input.hits, input.hits[0]!], finalLimit: 4, options: { candidateLimit: 2 } })
    assert.deepEqual(r.selected, input.hits.slice(0, 2)); assert(r.scope.includes('candidate-pool-truncated'))
  })
  await test('reranker-can-select-lower-ranked-retrieved-candidate', async () => {
    const r = await selectRecallCandidates({ ...input, options: { reranker: { id: 'test', rank: async ({ candidates }) => candidates.map((c, i) => ({ id: c.id, score: i })) } } })
    assert.equal(r.selected[0]?.id, 'c'); assert.equal(r.candidates[0]?.id, 'a')
  })
  for (const [id, output] of [
    ['foreign', [{ id: 'foreign', score: 1 }, { id: 'b', score: 0 }, { id: 'c', score: 0 }]],
    ['duplicate', [{ id: 'a', score: 1 }, { id: 'a', score: 0 }, { id: 'c', score: 0 }]],
    ['nan', [{ id: 'a', score: NaN }, { id: 'b', score: 0 }, { id: 'c', score: 0 }]],
  ] as const) await test(`invalid-reranker-${id}-falls-back`, async () => {
    const r = await selectRecallCandidates({ ...input, options: { reranker: { id, rank: async () => output } } })
    assert.equal(r.selected[0]?.id, 'a'); assert(r.scope.includes('reranker:failed-or-timeout-original-order'))
  })
  await test('reranker-timeout-aborts-and-retains-original-order', async () => {
    let signal: AbortSignal | undefined
    const r = await selectRecallCandidates({ ...input, options: { timeoutMs: 5, reranker: { id: 'slow', rank: args => {
      signal = args.signal; return new Promise(() => {})
    } } } })
    assert(signal?.aborted); assert.equal(r.selected[0]?.id, 'a')
  })
  await test('diagnostics-are-copied-and-observer-errors-ignored', () => {
    const event: RecallStageDiagnostic = { recallId: 'x', route: 'L1', stage: 'selection', elapsedMs: 0, factIds: ['a'] }
    emitRecallDiagnostic(e => { (e.factIds as string[]).push('b'); throw new Error('observer') }, event)
    assert.deepEqual(event.factIds, ['a'])
    assert.equal(evidenceGap('b', [{ ...event, stage: 'retrieval', factIds: ['a', 'b'] }, event]), 'selection')
  })
  await test('native-fixture-withdrawal-never-falls-back-to-scalar', () => {
    const f = createCrossTopicFixture(CROSS_TOPIC_CASES.find(c => c.id === 'withdrawn')!)
    assert(!collectCurrentL1(f.options, f.request.scope, 200).inputs.some(i => i.fact.id === 'tea'))
  })
  await test('all-cross-topic-cases-keep-access-and-time-boundaries', async () => {
    for (const c of CROSS_TOPIC_CASES) {
      const f = createCrossTopicFixture(c), events: RecallStageDiagnostic[] = []
      const r = await createV4GraphMemory({ ...f.options, retrievalMode: 'lexical', structuredRecall: false, diagnostics: e => events.push(e) }).recall(f.request)
      if (c.denied) { assert(!r.ok); assert.equal(events.length, 0); continue }
      if (c.id === 'meeting-direct' && !r.ok) {
        // Known unsupported recurring-time query, kept as a quality failure in the model report.
        assert.equal(r.error.code, 'invalid-request'); continue
      }
      assert(r.ok, `${c.id}: ${!r.ok && r.error.message}`)
      const eligible = events.find(e => e.stage === 'eligibility')!.factIds
      assert(!eligible.includes('private'))
      assert(!eligible.includes(c.mutation === 'past' ? 'city' : 'old-city'))
      if (['delete', 'revoke', 'permission', 'missing-time'].includes(c.mutation ?? '')) assert(!eligible.includes('tea'), c.id)
      for (const id of c.expected) assert(eligible.includes(id), `${c.id}: missing eligible gold ${id}`)
    }
  })
  await test('L1-reranker-source-mutation-is-rejected-before-delivery', async () => {
    const f = createCrossTopicFixture(CROSS_TOPIC_CASES[0]!)
    let invoked = false
    const r = await createV4GraphMemory({ ...f.options, retrievalMode: 'lexical', structuredRecall: false, candidateSelection: { reranker: {
      id: 'mutating-test', rank: async ({ candidates }) => {
        invoked = true
        f.repository.transaction(s => { const ep = s.episodes.find(e => e.id === 'ep-tea')!; ep.contentState = 'deleted'; ep.deletedAt = 150; delete ep.content })
        return candidates
      },
    } } }).recall({ ...f.request, query: '用户喜欢喝乌龙茶' })
    assert(invoked); assert(!r.ok); assert.equal(r.error.code, 'stale-projection')
  })
  await test('L2-reranker-order-is-accepted-by-seed-port', async () => {
    const f = await createNativeL2Fixture(); assert((await f.publish()).ok)
    let chosen = ''
    const port = createV4L2Memory({ ...f.options, retrievalMode: 'lexical', candidateSelection: { reranker: { id: 'reverse-test', rank: async ({ candidates }) => {
      chosen = candidates[candidates.length - 1]!.id; return candidates.map((c, i) => ({ id: c.id, score: i + 10 }))
    } } } })
    const r = await port.recall({ ...f.request, budget: { ...f.request.budget, maxSeeds: 1 } })
    assert(r.ok, r.ok ? undefined : r.error.message); assert(chosen); assert(r.value.trace.searchScope.includes('reranker:applied:reverse-test'))
    assert.equal(graphHash(r.value.evidence.groups[0]!.root), chosen)
    assert.equal(r.value.trace.candidateRefs.length, 2); assert.equal(r.value.trace.usage.seeds, 1)
  })
  return { checks }
}
