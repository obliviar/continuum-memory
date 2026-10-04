import assert from 'node:assert/strict'
import type { GraphRecallRequest, GraphResult } from '@continuum-memory/contracts'
import type { MemoryV4Snapshot } from '../../v4/domain/types'
import { createV4GraphMemory, V4_GRAPH_BUDGET } from '../adapters/v4-graph-memory'
import { createV4L2Memory, V4_L2_BUDGET } from '../adapters/v4-l2-memory'
import { createV4GraphTestRepository, V4_TEST_SCOPE as scope } from '../fixtures/v4-direct-memory'
import { directQuerySlot } from '../recall/direct-structured'
import type { DirectSemanticOptions } from '../recall/direct-semantic'

const ok = <T>(r: GraphResult<T>): T => { if (!r.ok) throw Error(`${r.error.code}: ${r.error.message}`); return r.value }
const query = '偏爱的饮品是哪种'
export function createDirectStructuredFixture(drink = '乌龙茶') {
  const repository = createV4GraphTestRepository(), template = repository.snapshot()
  repository.transaction(s => {
    const rows = [
      { id: 'drink', subjectId: scope.ownerId, predicate: 'preference.drink', text: `用户喜欢喝${drink}`, value: drink },
      { id: 'food', subjectId: scope.ownerId, predicate: 'preference.food', text: '用户喜欢吃面条', value: '面条' },
      { id: 'other', subjectId: 'another-person', predicate: 'preference.drink', text: '小周喜欢喝咖啡', value: '咖啡' },
    ]
    s.facts = rows.map(row => ({ ...template.facts[0]!, id: row.id, subjectId: row.subjectId,
      predicate: row.predicate, memoryKey: row.predicate, canonicalText: row.text, object: row.value,
      normalizedValue: row.value, evidenceLinkIds: [`ev-${row.id}`] }))
    s.factVersions = rows.map(row => ({ ...template.factVersions[0]!, id: `v-${row.id}`, factId: row.id,
      subjectId: row.subjectId, predicate: row.predicate, canonicalText: row.text, object: row.value,
      normalizedValue: row.value, evidenceLinkIds: [`ev-${row.id}`] }))
    s.episodes = rows.map(row => ({ ...template.episodes[0]!, id: `ep-${row.id}`, content: row.text }))
    s.evidenceLinks = rows.map(row => ({ ...template.evidenceLinks[0]!, id: `ev-${row.id}`, factId: row.id, episodeId: `ep-${row.id}` }))
  })
  let persisted: string | undefined, allowed = true
  const options = { repository, persistence: { load: () => persisted, save: (s: string) => { persisted = s } },
    authorizeScope: (s: typeof scope) => s.ownerId === scope.ownerId && s.agentId === scope.agentId,
    canRead: () => allowed, countTokens: (s: string) => Buffer.byteLength(s), now: () => 200 }
  const request = (text = query): GraphRecallRequest => ({ protocolVersion: 'memory-graph/v1', recallId: text,
    query: text, scope, mode: 'direct-only', temporal: { knownAt: 200, valid: { kind: 'at', at: 200 } },
    budget: { ...V4_GRAPH_BUDGET }, sharePolicies: ['local-only'], sensitivities: ['normal'] })
  return { repository, options, request, deny: () => { allowed = false } }
}

/** Separate synthetic fixtures with distractors; optional real-model provider uses exactly the same gold. */
export async function runDirectStructuredRegression(prepareSemantic?: (snapshot: MemoryV4Snapshot) => Promise<DirectSemanticOptions>) {
  const checks: { id: string; passed: boolean; error?: string }[] = []
  const test = async (id: string, run: () => void | Promise<void>) => {
    try { await run(); checks.push({ id, passed: true }) }
    catch (error) { checks.push({ id, passed: false, error: String(error) }) }
  }
  const recall = async (f: ReturnType<typeof createDirectStructuredFixture>, request = f.request()) => {
    const semantic = await prepareSemantic?.(f.repository.snapshot())
    return createV4GraphMemory({ ...f.options, semantic }).recall(request)
  }
  const queries = [query, '我偏爱的饮料有哪些？', '我喜欢喝什么', '请告诉我，我的饮品偏好是什么',
    '平时爱喝啥呢', 'what beverages do i prefer', 'what do i like to drink']
  for (const text of queries) await test(`self-slot:${text}`, async () => {
    const f = createDirectStructuredFixture(), r = ok(await recall(f, f.request(text)))
    assert.deepEqual(r.evidence.claims.map(c => c.kind === 'direct' ? c.fact.id : 'derived'), ['drink'])
    assert.equal(r.evidence.claims[0]!.content, '用户喜欢喝乌龙茶')
    assert.ok(r.trace.searchScope.includes('structured-slot:preference.drink'))
    assert.ok(r.trace.searchScope.includes('structured-slot-filter:active'))
  })
  await test('unsupported-subject-negation-and-extra-constraints-do-not-trigger-slot', () => {
    for (const text of ['小周偏爱的饮品是哪种', '他偏爱的饮品是哪种', '你喜欢喝什么', '我不喜欢喝什么',
      '我为什么喜欢喝什么', '如果我喜欢喝什么', '我喜欢喝什么牌子的饮料', '我喜欢喝什么，不要茶',
      'what does she prefer to drink', '我喜欢喝什么和吃什么', '喜欢', '饮品', '偏爱'])
      assert.equal(directQuerySlot(text), undefined, text)
  })
  await test('not-hardcoded-to-tea-and-preserves-multiple-preferences', async () => {
    const f = createDirectStructuredFixture('气泡水')
    f.repository.transaction(s => {
      s.facts[1]!.predicate = 'preference.drink'; s.factVersions[1]!.predicate = 'preference.drink'
      for (const row of [s.facts[1]!, s.factVersions[1]!]) Object.assign(row,
        { canonicalText: '用户喜欢喝柠檬水', object: '柠檬水', normalizedValue: '柠檬水' })
      s.episodes[1]!.content = '用户喜欢喝柠檬水'
    })
    const r = ok(await recall(f))
    assert.deepEqual(r.evidence.claims.map(c => c.content).sort(), ['用户喜欢喝气泡水', '用户喜欢喝柠檬水'].sort())
  })
  await test('exact-field-and-owner-required-not-a-predicate-prefix', async () => {
    const f = createDirectStructuredFixture()
    f.repository.transaction(s => { s.facts[0]!.predicate = 'preference.drink.brand'; s.factVersions[0]!.predicate = 'preference.drink.brand' })
    assert.deepEqual(ok(await recall(f)).evidence.claims, [])
  })
  await test('no-self-preference-does-not-borrow-another-persons-value', async () => {
    const f = createDirectStructuredFixture()
    f.repository.transaction(s => { s.facts[0]!.subjectId = 'third-person'; s.factVersions[0]!.subjectId = 'third-person' })
    assert.deepEqual(ok(await recall(f, f.request('我喜欢喝什么'))).evidence.claims, [])
  })
  await test('polarity-is-preserved-not-promoted-to-a-positive-preference', async () => {
    const f = createDirectStructuredFixture()
    f.repository.transaction(s => {
      for (const row of [s.facts[0]!, s.factVersions[0]!]) Object.assign(row, { polarity: 'negative', canonicalText: '用户不喜欢喝乌龙茶' })
      s.episodes[0]!.content = '用户不喜欢喝乌龙茶'
    })
    const r = ok(await recall(f)); assert.deepEqual(r.evidence.claims.map(c => c.kind === 'direct' ? c.fact.id : 'derived'), ['drink'])
    assert.equal(r.evidence.claims[0]!.polarity, 'negative'); assert.equal(r.evidence.claims[0]!.content, '用户不喜欢喝乌龙茶')
  })
  for (const boundary of ['deleted', 'time', 'unverified', 'policy', 'denied'] as const) await test(`boundary:${boundary}`, async () => {
    const f = createDirectStructuredFixture()
    f.repository.transaction(s => {
      if (boundary === 'deleted') { s.episodes[0]!.contentState = 'deleted'; s.episodes[0]!.deletedAt = 150; delete s.episodes[0]!.content }
      if (boundary === 'time') { s.facts[0]!.validFrom = 250; s.factVersions[0]!.validFrom = 250 }
      if (boundary === 'unverified') s.facts[0]!.verificationState = 'pending'
      if (boundary === 'policy') s.facts[0]!.sharePolicy = 'ask'
    })
    if (boundary === 'denied') f.deny()
    assert.deepEqual(ok(await recall(f)).evidence.claims, [])
  })
  await test('scope-denial-remains-an-error', async () => {
    const f = createDirectStructuredFixture(), req = f.request()
    const r = await recall(f, { ...req, scope: { ...scope, ownerId: 'other-owner' } })
    assert.equal(r.ok, false); if (!r.ok) assert.equal(r.error.code, 'scope-denied')
  })
  await test('node-budget-prevents-structured-evidence-from-bypassing-limits', async () => {
    const f = createDirectStructuredFixture(), req = f.request()
    const r = ok(await recall(f, { ...req, budget: { ...req.budget, maxNodes: 0 } }))
    assert.deepEqual(r.evidence.claims, []); assert.equal(r.trace.stopReason, 'node-budget')
  })
  await test('slot-matching-happens-before-top-k-and-source-version-is-preserved', async () => {
    const f = createDirectStructuredFixture(), req = f.request('我喜欢喝什么')
    const r = ok(await recall(f, { ...req, budget: { ...req.budget, maxSeeds: 1 } }))
    assert.deepEqual(r.evidence.claims.map(c => c.kind === 'direct' ? c.fact : null), [{ kind: 'v4-fact', id: 'drink', version: 1 }])
    assert.equal(r.evidence.claims[0]!.sources[0]!.episodeId, 'ep-drink')
  })
  await test('updated-preference-returns-the-current-exact-version', async () => {
    const f = createDirectStructuredFixture()
    f.repository.transaction(s => {
      const fact = s.facts[0]!, old = s.factVersions[0]!
      old.transactionClosedAt = 150
      Object.assign(fact, { canonicalText: '用户喜欢喝豆浆', object: '豆浆', normalizedValue: '豆浆', updatedAt: 150 })
      s.episodes[0]!.content = fact.canonicalText
      s.factVersions.push({ ...old, id: 'v-drink-2', version: 2, operation: 'REFINE', transactionClosedAt: undefined,
        recordedAt: 150, canonicalText: fact.canonicalText, object: fact.object, normalizedValue: fact.normalizedValue })
    })
    const r = ok(await recall(f))
    assert.deepEqual(r.evidence.claims.map(c => c.content), ['用户喜欢喝豆浆'])
    assert.deepEqual(r.evidence.claims.map(c => c.kind === 'direct' ? c.fact.version : null), [2])
  })
  await test('desktop-l2-host-delegates-ordinary-questions-to-the-new-l1-route', async () => {
    const f = createDirectStructuredFixture(), semantic = await prepareSemantic?.(f.repository.snapshot())
    let relations: string | undefined
    const port = createV4L2Memory({ ...f.options, semantic,
      relationPersistence: { load: () => relations, save: value => { relations = value } } })
    const r = ok(await port.recall({ ...f.request(), budget: { ...V4_L2_BUDGET } }))
    assert.deepEqual(r.evidence.claims.map(c => c.kind === 'direct' ? c.fact.id : 'derived'), ['drink'])
    assert.ok(r.trace.searchScope.includes('structured-slot:preference.drink')); assert.equal(relations, undefined)
  })
  return { kind: prepareSemantic ? 'provider-assisted-structured-regression' : 'offline-structured-regression',
    tests: checks.length, passed: checks.filter(c => c.passed).length, checks }
}
