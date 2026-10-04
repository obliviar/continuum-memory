import assert from 'node:assert/strict'
import { createL2HostFixture } from './l2-host-regression'
import { createV4L2Memory } from '../adapters/v4-l2-memory'
import { createMemoryEmbeddingIndex } from '../../long-term/embedding-index'
import { searchDirectSemantic, type SemanticResult } from '../recall/direct-semantic'
import { selectL2SemanticFallback, validL2SemanticFallback } from '../recall/l2-semantic-fallback'

const policy = { model: 'toy-margin', minCosine: 0.6, minMargin: 0.1 }
const vector = (score: number) => [score, Math.sqrt(1 - score * score)]
const result = (first: number, second: number): SemanticResult => ({ hits: [], incomplete: false,
  scope: ['semantic:ready'], competition: [{ id: 'a', score: first }, { id: 'b', score: second }] })

async function fixture(score = 0.7, second = 0.3) {
  const f = createL2HostFixture(); await f.publish()
  const cache = createMemoryEmbeddingIndex()
  cache.putBatch(f.repository.snapshot().facts.map(fact => ({ memoryId: fact.id, model: policy.model,
    content: fact.canonicalText, vector: vector(fact.id === 'f2' ? score : second) })))
  let calls = 0
  const semantic = { model: policy.model, dimensions: 2, index: cache,
    embedQuery: async () => { calls++; return { model: policy.model, vector: [1, 0] } } }
  return { ...f, cache, semantic, calls: () => calls }
}

/** Toy vectors verify selection and failure boundaries, never learned-model quality. */
export async function runL2SemanticFallbackRegression() {
  const checks: { id: string; passed: boolean; error?: string }[] = []
  const test = async (id: string, action: () => void | Promise<void>) => {
    try { await action(); checks.push({ id, passed: true }) }
    catch (error) { checks.push({ id, passed: false, error: String(error) }) }
  }
  await test('runner-up-below-floor-remains-visible', async () => {
    const f = await fixture(0.69, 0.59)
    const r = await searchDirectSemantic('改写', f.repository.snapshot().facts, { ...f.semantic, minCosine: 0.65 }, 2000)
    assert.equal(r.hits.length, 1); assert.equal(r.competition.length, 2)
    assert.ok(r.competition[1]!.score < 0.65)
    assert.equal(selectL2SemanticFallback(r, { ...policy, minMargin: 0.15 }).hits.length, 0)
  })
  for (const [id, first, second, expected] of [
    ['clear-leader', 0.7, 0.4, 'candidate'], ['near-tie', 0.7, 0.65, 'ambiguous'],
    ['exact-tie', 0.7, 0.7, 'ambiguous'], ['weak-leader', 0.5, 0.1, 'below-floor'],
  ] as const) await test(id, () => {
    const r = selectL2SemanticFallback(result(first, second), policy)
    assert.ok(r.scope.includes(`semantic-fallback:${expected}`))
    assert.equal(r.hits.length, expected === 'candidate' ? 1 : 0)
  })
  await test('partial-cache-cannot-establish-a-margin', () => {
    assert.equal(selectL2SemanticFallback({ ...result(0.7, 0.1), incomplete: true }, policy).hits.length, 0)
  })
  await test('single-fact-is-not-an-infinite-margin', () => {
    const r = result(0.7, 0.1); r.competition.pop()
    assert.ok(selectL2SemanticFallback(r, policy).scope.includes('semantic-fallback:insufficient-competition'))
  })
  await test('invalid-policy-and-model-change-disable-relaxation', async () => {
    const f = await fixture()
    for (const p of [{ ...policy, model: 'other' }, { ...policy, minCosine: NaN },
      { ...policy, minCosine: 0.9 }, { ...policy, minMargin: 0 }, { ...policy, minMargin: Infinity }])
      assert.equal(validL2SemanticFallback(p, f.semantic), false)
    const r = await createV4L2Memory({ ...f.options, semantic: f.semantic, semanticFallback: { ...policy, model: 'other' } })
      .recall(f.request('为什么赛事停办'))
    assert.ok(r.ok); assert.equal(r.value.evidence.claims.length, 0)
    assert.ok(r.value.trace.searchScope.includes('semantic-fallback:invalid-config'))
  })
  await test('default-path-keeps-original-threshold', async () => {
    const f = await fixture()
    const r = await createV4L2Memory({ ...f.options, semantic: f.semantic }).recall(f.request('为什么赛事停办'))
    assert.ok(r.ok); assert.equal(r.value.evidence.claims.length, 0)
  })
  await test('opt-in-paraphrase-reuses-one-inference-and-preserves-relations', async () => {
    const f = await fixture(), before = f.options.relationPersistence.load()
    const r = await createV4L2Memory({ ...f.options, semantic: f.semantic, semanticFallback: policy }).recall(f.request('为什么赛事停办'))
    assert.ok(r.ok); assert.equal(r.value.evidence.relations!.length, 1)
    assert.equal(r.value.trace.candidateRefs.length, 1)
    assert.ok(r.value.trace.searchScope.includes('semantic-fallback:admitted'))
    assert.ok(!r.value.trace.searchScope.some(s => s.startsWith('seed-abstention:')))
    assert.equal(f.calls(), 1); assert.equal(f.options.relationPersistence.load(), before)
  })
  await test('exact-target-does-not-need-fallback', async () => {
    const f = await fixture()
    const r = await createV4L2Memory({ ...f.options, semantic: f.semantic, semanticFallback: policy }).recall(f.request())
    assert.ok(r.ok); assert.equal(r.value.trace.candidateRefs.length, 1)
    assert.ok(r.value.trace.searchScope.includes('semantic-fallback:not-needed'))
  })
  await test('known-target-mismatch-cannot-promote-runner-up', async () => {
    const f = await fixture()
    f.repository.transaction(s => {
      const fields = { canonicalText: '会议改期', predicate: 'event.meeting', object: '会议改期',
        normalizedValue: '会议改期', evidenceLinkIds: ['ev3'] }
      s.episodes[0]!.content += '会议改期。'
      s.evidenceLinks.push({ ...s.evidenceLinks[0]!, id: 'ev3', factId: 'f3' })
      s.facts.push({ ...s.facts[0]!, ...fields, id: 'f3' })
      s.factVersions.push({ ...s.factVersions[0]!, ...fields, id: 'v3', factId: 'f3' })
    })
    // Recreate the explicit test relations for the new immutable L1 view.
    f.options.relationPersistence.save('{}'); await f.publish()
    f.cache.putBatch([{ memoryId: 'f3', model: policy.model, content: '会议改期', vector: vector(0.3) }])
    const r = await createV4L2Memory({ ...f.options, semantic: f.semantic, semanticFallback: policy }).recall(f.request('为什么会议取消'))
    assert.ok(r.ok); assert.equal(r.value.evidence.claims.length, 0)
    assert.ok(r.value.trace.searchScope.includes('semantic-fallback:target-mismatch'))
  })
  await test('cache-missing-competitor-blocks-fallback', async () => {
    const f = await fixture(); f.cache.removeMemoryIds(['f'])
    const r = await createV4L2Memory({ ...f.options, semantic: f.semantic, semanticFallback: policy }).recall(f.request('为什么赛事停办'))
    assert.ok(r.ok); assert.equal(r.value.evidence.claims.length, 0)
    assert.ok(r.value.trace.searchScope.includes('semantic-fallback:unavailable-or-incomplete'))
  })
  await test('permission-denied-before-embedding', async () => {
    const f = await fixture(); f.deny()
    const r = await createV4L2Memory({ ...f.options, semantic: f.semantic, semanticFallback: policy }).recall(f.request('为什么赛事停办'))
    assert.equal(r.ok, false); if (!r.ok) assert.equal(r.error.code, 'stale-projection')
    assert.equal(f.calls(), 0)
  })
  await test('unsupported-historical-view-never-runs-fallback', async () => {
    const f = await fixture(), request = f.request('为什么赛事停办')
    const r = await createV4L2Memory({ ...f.options, semantic: f.semantic, semanticFallback: policy })
      .recall({ ...request, temporal: { ...request.temporal, knownAt: 99 } })
    assert.equal(r.ok, false); assert.equal(f.calls(), 0)
  })
  return { tests: checks.length, passed: checks.filter(c => c.passed).length, checks }
}
