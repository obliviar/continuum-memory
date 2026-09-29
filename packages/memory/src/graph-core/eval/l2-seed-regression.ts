import assert from 'node:assert/strict'
import type { GraphResult } from '@continuum-memory/contracts'
import { rankL2Seeds, type L2SeedDocument } from '../recall/l2-seed-ranking'
import { createV4L2Memory } from '../adapters/v4-l2-memory'
import { createL2HostFixture } from './l2-host-regression'
import { createMemoryEmbeddingIndex } from '../../long-term/embedding-index'

const scope = { ownerId: 'owner', agentId: 'agent' }
const value = <T>(r: GraphResult<T>): T => { if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`); return r.value }
const doc = (id: string, text: string, names: string[] = []): L2SeedDocument =>
  ({ id, factId: `fact-${id}`, text, predicate: 'event', entityNames: names })

export async function runL2SeedRegression() {
  const checks: { id: string; passed: boolean; error?: string }[] = []
  const test = async (id: string, action: () => void | Promise<void>) => {
    try { await action(); checks.push({ id, passed: true }) }
    catch (error) { checks.push({ id, passed: false, error: String(error) }) }
  }
  await test('exact-target-excludes-a-strong-fuzzy-distractor', () => {
    const r = rankL2Seeds('比赛取消', scope, [doc('target', '比赛取消'), doc('notice', '比赛取消通知')],
      [{ id: 'fact-notice', score: 1 }], 4)
    assert.deepEqual(r.items.map(i => i.id), ['target']); assert.ok(r.scope.includes('seed-selection:exact-claim'))
  })
  await test('negation-is-not-erased-to-match-positive-target', () => {
    const r = rankL2Seeds('比赛没有取消', scope, [doc('positive', '比赛取消'), doc('negative', '比赛没有取消。')], [], 4)
    assert.deepEqual(r.items.map(i => i.id), ['negative'])
  })
  await test('same-text-does-not-merge-distinct-claim-identities', () => {
    const r = rankL2Seeds('比赛取消', scope, [doc('b', '比赛取消'), doc('a', '比赛取消')], [], 4)
    assert.deepEqual(r.items.map(i => i.id), ['a', 'b'])
  })
  await test('same-fact-can-yield-distinct-exact-claim-versions', () => {
    const a = doc('claim-v1', 'event A'), b = { ...doc('claim-v2', 'event B'), factId: a.factId }
    const r = rankL2Seeds('改写问法', scope, [a, b], [{ id: a.factId, score: 1 }], 4)
    assert.deepEqual(new Set(r.items.map(i => i.id)), new Set(['claim-v1', 'claim-v2']))
  })
  await test('exact-entity-alias-retains-all-matching-identities-only', () => {
    const r = rankL2Seeds('Ａｌｅｘ', scope, [doc('a', 'works here', ['Alex']), doc('b', 'lives there', ['alex']),
      doc('unrelated', 'Alexandra works elsewhere')], [{ id: 'fact-unrelated', score: 1 }], 4)
    assert.deepEqual(r.items.map(i => i.id), ['a', 'b']); assert.ok(r.scope.includes('seed-selection:exact-entity-name'))
  })
  await test('seed-budget-does-not-hide-truncation', () => {
    const r = rankL2Seeds('比赛取消', scope, [doc('a', '比赛取消'), doc('b', '比赛取消')], [], 1)
    assert.equal(r.items.length, 1); assert.ok(r.scope.includes('seed-top-k-truncated'))
    assert.equal(rankL2Seeds('比赛取消', scope, [doc('a', '比赛取消')], [], 0).items.length, 0)
  })
  await test('hybrid-ranks-deduplicate-cross-route-hits', () => {
    const r = rankL2Seeds('比赛', scope, [doc('a', '比赛取消'), doc('b', '比赛开幕'), doc('c', '其他事项')],
      [{ id: 'fact-b', score: 1 }, { id: 'fact-c', score: 0.9 }], 4)
    assert.equal(r.items[0]!.id, 'b'); assert.equal(new Set(r.items.map(i => i.id)).size, r.items.length)
    assert.ok(r.scope.includes('seed-selection:hybrid'))
  })
  await test('no-matching-route-does-not-select-a-random-seed', () => {
    assert.equal(rankL2Seeds('旅行', scope, [doc('a', '设备故障')], [], 4).items.length, 0)
  })
  for (const query of ['请问，为什么比赛取消？', '比赛取消是什么原因？', '比赛取消的原因有哪些呢？'])
    await test(`question-target:${query}`, async () => {
      const f = createL2HostFixture(); await f.publish()
      const r = value(await f.port.recall(f.request(query)))
      assert.equal(r.evidence.relations!.length, 1)
      assert.equal(r.trace.candidateRefs.length, 1); assert.ok(r.trace.searchScope.includes('seed-selection:exact-claim'))
      assert.equal(r.evidence.claims.find(c => c.ref.id === r.trace.candidateRefs[0]!.id)!.content, '比赛取消')
    })
  await test('distractor-does-not-start-an-unrelated-traversal', async () => {
    const f = createL2HostFixture()
    f.repository.transaction(s => {
      const fields = { canonicalText: '比赛取消通知', predicate: 'event.notice', object: '比赛取消通知', normalizedValue: '比赛取消通知', evidenceLinkIds: ['ev3'] }
      s.episodes[0]!.content += '另有比赛取消通知。'
      s.evidenceLinks.push({ ...s.evidenceLinks[0]!, id: 'ev3', factId: 'f3' })
      s.facts.push({ ...s.facts[0]!, ...fields, id: 'f3' })
      s.factVersions.push({ ...s.factVersions[0]!, ...fields, id: 'v3', factId: 'f3' })
    })
    await f.publish(); const r = value(await f.port.recall(f.request()))
    assert.equal(r.trace.candidateRefs.length, 1); assert.equal(r.evidence.claims.length, 2)
    assert.ok(!r.evidence.claims.some(c => c.content === '比赛取消通知'))
  })
  await test('paraphrase-can-use-cached-semantic-entry-without-new-relations', async () => {
    const f = createL2HostFixture(); await f.publish()
    const cache = createMemoryEmbeddingIndex()
    cache.putBatch(f.repository.snapshot().facts.map(fact => ({ memoryId: fact.id, model: 'toy', content: fact.canonicalText,
      vector: fact.id === 'f2' ? [1, 0] : [0, 1] })))
    let received = ''
    const port = createV4L2Memory({ ...f.options, semantic: { model: 'toy', dimensions: 2, index: cache,
      embedQuery: async query => { received = query; return { model: 'toy', vector: [1, 0] } } } })
    const before = f.options.relationPersistence.load(), r = value(await port.recall(f.request('为何赛事停办')))
    assert.equal(received, '赛事停办'); assert.equal(r.trace.candidateRefs.length, 1)
    assert.equal(r.evidence.relations!.length, 1); assert.ok(r.trace.searchScope.includes('seed-route:dense'))
    assert.ok(r.trace.searchScope.includes('semantic:ready')); assert.equal(f.options.relationPersistence.load(), before)
  })
  await test('unsupported-historical-view-never-enters-vector-lookup', async () => {
    const f = createL2HostFixture(); await f.publish(); let lookups = 0, queries = 0
    const port = createV4L2Memory({ ...f.options, semantic: { model: 'toy', dimensions: 2,
      index: { get: () => { lookups++; return [1, 0] } },
      embedQuery: async () => { queries++; return { model: 'toy', vector: [1, 0] } } } })
    const request = f.request(), r = await port.recall({ ...request, temporal: { ...request.temporal, knownAt: 99 } })
    assert.equal(r.ok, false); if (!r.ok) assert.equal(r.error.code, 'unsupported-capability')
    assert.equal(lookups, 0); assert.equal(queries, 0)
  })
  await test('missing-vectors-remain-visible-with-lexical-or-exact-fallback', async () => {
    const f = createL2HostFixture(); await f.publish()
    const port = createV4L2Memory({ ...f.options, semantic: { model: 'toy', dimensions: 2,
      index: { get: () => undefined }, embedQuery: async () => undefined } })
    const r = value(await port.recall(f.request()))
    assert.equal(r.evidence.relations!.length, 1); assert.ok(r.trace.searchScope.includes('semantic:empty-index'))
    assert.ok(r.trace.searchScope.includes('semantic-incomplete'))
  })
  return { tests: checks.length, passed: checks.filter(c => c.passed).length, checks }
}
