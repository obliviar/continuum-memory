import assert from 'node:assert/strict'
import type { GraphRecallRequest, GraphRecallResult, GraphResult } from '@continuum-memory/contracts'
import { rankL2Seeds, type L2SeedDocument } from '../recall/l2-seed-ranking'
import { createMemoryV4Repository } from '../../v4/repository/memory-v4-repository'
import { createGraphExtractionRun } from '../../long-term/graph-extraction-result'
import { createGraphPredicateRegistry, normalizeGraphExtraction } from '../../long-term/graph-identity-normalization'
import { assessGraphClaim, confirmGraphClaim, createGraphL1Store, createGraphL1Writer } from '../../long-term/graph-l1-write'
import { createGraphSemanticRepository } from '../repository/semantic-repository'
import { createGraphL1ProjectionRepository } from '../repository/l1-projection-repository'
import { createGraphRelationRepository } from '../repository/relation-repository'
import { createV4L2Memory, V4_L2_BUDGET, type V4L2MemoryOptions } from '../adapters/v4-l2-memory'
import { selectRetrievableGraphBundle, entityCandidateBindings } from '../adapters/accepted-l1-input'
import { createV4RelationSourceReader } from '../adapters/v4-relation-sources'

const scope = { ownerId: 'owner', agentId: 'agent' }
const at = Date.UTC(2026, 8, 27, 12)
const memory = () => { let data: string | undefined; return { load: () => data, save: (s: string) => { data = s } } }
const ok = <T>(r: GraphResult<T>): T => { if (!r.ok) throw Error(`${r.error.code}: ${r.error.message}`); return r.value }
const lin = { key: 'lin-v1', names: ['林晓', '林同学', 'Lin'] }, zhou = { key: 'zhou-v1', names: ['周宁', '周同学'] }
const doc = (id: string, text: string, binding = zhou): L2SeedDocument =>
  ({ id, factId: id, text, predicate: 'event', entityNames: binding.names, entityBindings: [binding] })

/** Synthetic published native L1, with separate people and disjoint valid dates. No invented L2 edges. */
export async function createL2EntityTimeFixture() {
  const repository = createMemoryV4Repository({ now: () => at }), store = createGraphL1Store(memory())
  const semantic = createGraphSemanticRepository(memory(), repository), registry = createGraphPredicateRegistry()
  const projection = createGraphL1ProjectionRepository(memory(), semantic, repository, store)
  const sync = async () => { ok(await semantic.syncFromClaims(store, repository, registry, scope)); assert(projection.sync()) }
  const writer = createGraphL1Writer(repository, store, registry, scope, { syncFromClaims: sync })
  const entities = [
    { ref: { kind: 'entity' as const, id: 'lin', version: 1 }, scope, entityType: 'person', canonicalName: '林晓', aliases: ['林同学', 'Lin', '同学'] },
    { ref: { kind: 'entity' as const, id: 'zhou', version: 1 }, scope, entityType: 'person', canonicalName: '周宁', aliases: ['周同学', '同学'] },
    { ref: { kind: 'entity' as const, id: 'acme', version: 1 }, scope, entityType: 'organization', canonicalName: 'Acme', aliases: [] },
  ]
  for (const [i, name] of ['林晓', '周宁'].entries()) {
    const sourceText = `${name} works at Acme`
    const run = createGraphExtractionRun({ sourceId: `synthetic-person-${i}`, sourceText, modelId: 'synthetic-fixture', rawOutput: { graph: {
      entities: [{ id: 'p', type: 'person', text: name, span: { start: 0, end: name.length }, modelScore: 0.9 },
        { id: 'o', type: 'organization', text: 'Acme', span: { start: sourceText.length - 4, end: sourceText.length }, modelScore: 0.9 }],
      facts: [{ id: 'f', subjectMentionId: 'p', predicate: 'works at', object: { mentionId: 'o' },
        evidenceSpan: { start: 0, end: sourceText.length }, modelScore: 0.9,
        context: { negation: { value: false, resolution: 'resolved' }, condition: { value: null, resolution: 'absent' },
          time: { value: i === 0 ? '2026-09-26' : '2026-09-27', resolution: 'resolved' }, speaker: { value: null, resolution: 'absent' } } }] } } })
    const fact = normalizeGraphExtraction(run, { scope, entities, contextEntityIds: ['lin', 'zhou', 'acme'] }).facts[0]!
    const review = confirmGraphClaim(assessGraphClaim(run, fact, { sensitivity: 'normal', sharePolicy: 'allow-remote' }, at),
      'Synthetic approval; not human-reviewed user data', at)
    assert.equal((await writer.submit(run, fact, review, entities))?.state, 'published')
  }
  let readable = true
  const options: V4L2MemoryOptions = { repository, persistence: memory(), relationPersistence: memory(),
    now: () => at + 100, countTokens: s => Buffer.byteLength(s), includeOwnedSessions: true,
    authorizeScope: s => s.ownerId === scope.ownerId && s.agentId === scope.agentId && s.sessionId === undefined,
    canRead: () => readable,
    acceptedBundle: () => selectRetrievableGraphBundle(projection.snapshot()?.semanticBundle, store.tasks()) }
  const relations = createGraphRelationRepository({ coreSnapshot: () => projection.snapshot()!, persistence: memory(),
    now: () => at, verifySources: createV4RelationSourceReader(options).verify })
  options.nativeRelations = { projection: () => projection.snapshot(), repository: () => relations }
  const request = (query: string): GraphRecallRequest => ({ protocolVersion: 'memory-graph/v1', recallId: query, query, scope,
    mode: 'direct-only', temporal: { knownAt: at + 100, valid: { kind: 'at', at } },
    sharePolicies: ['allow-remote'], sensitivities: ['normal'], budget: { ...V4_L2_BUDGET } })
  const claims = projection.snapshot()!.semanticBundle.claims
  const personClaim = (id: string) => claims.find(c => Object.values(c.atom.args).some(t => t.kind === 'entity' && t.ref.id === id))!
  return { repository, projection, options, request, relations, personClaim, deny: () => { readable = false } }
}

export async function runL2EntityTimeRegression(validatePrompt?: (result: GraphRecallResult) => string) {
  const checks: { id: string; passed: boolean; error?: string }[] = []
  const test = async (id: string, run: () => void | Promise<void>) => {
    try { await run(); checks.push({ id, passed: true }) }
    catch (error) { checks.push({ id, passed: false, error: String(error) }) }
  }
  await test('known-person-remains-a-constraint-after-their-time-window-is-excluded', () => {
    const r = rankL2Seeds('林同学上传失败', scope, [doc('zhou', '上传失败')], [{ id: 'zhou', score: 1 }], 4, [lin, zhou])
    assert.deepEqual(r.items, []); assert.ok(r.scope.includes('seed-abstention:entity-target-unresolved'))
  })
  await test('an-exact-text-hit-does-not-override-an-explicit-entity-binding', () => {
    assert.deepEqual(rankL2Seeds('林同学上传失败', scope, [doc('zhou', '林同学上传失败')], [], 4, [lin, zhou]).items, [])
  })
  await test('alias-retains-exact-entity-identity', () => {
    const r = rankL2Seeds('林同学', scope, [doc('lin', '上传失败', lin), doc('zhou', '上传失败')], [], 4)
    assert.deepEqual(r.items.map(i => i.id), ['lin'])
  })
  await test('same-name-people-are-not-merged-or-arbitrarily-resolved', () => {
    const a = { key: 'a-v1', names: ['小王'] }, b = { key: 'b-v1', names: ['小王'] }
    const r = rankL2Seeds('小王', scope, [doc('a', '上传失败', a), doc('b', '登录成功', b)], [], 4)
    assert.deepEqual(new Set(r.items.map(i => i.id)), new Set(['a', 'b']))
    assert.ok(r.scope.includes('seed-entity-target:ambiguous-identity'))
  })
  await test('entity-version-is-part-of-the-constraint', () => {
    const later = { ...lin, key: 'lin-v2' }
    assert.deepEqual(rankL2Seeds('林同学', scope, [doc('old', '上传失败', lin)], [], 4, [later]).items, [])
  })
  await test('latin-prefix-is-not-an-entity-mention', () => {
    const alex = { key: 'alex', names: ['Alex'] }
    const r = rankL2Seeds('Alexandra', scope, [doc('a', '其他事件', alex)], [{ id: 'a', score: 1 }], 4, [alex])
    assert.ok(r.scope.includes('seed-entity-mentions:0'))
  })
  await test('longer-chinese-name-wins-over-its-contained-prefix', () => {
    const short = { key: 's', names: ['张三'] }, long = { key: 'l', names: ['张三丰'] }
    const r = rankL2Seeds('张三丰', scope, [doc('s', '上传失败', short), doc('l', '上传失败', long)], [], 4)
    assert.deepEqual(r.items.map(i => i.id), ['l'])
  })
  await test('multi-entity-query-requires-all-explicit-mentions', () => {
    const both = { ...doc('both', '林晓与周宁合作'), entityNames: [...lin.names, ...zhou.names], entityBindings: [lin, zhou] }
    const r = rankL2Seeds('林晓与周宁', scope, [doc('lin', '林晓合作', lin), both], [{ id: 'lin', score: 1 }], 4)
    assert.deepEqual(r.items.map(i => i.id), ['both'])
  })
  await test('single-character-name-is-not-inferred-inside-prose', () => {
    const r = rankL2Seeds('王者比赛', scope, [], [], 4, [{ key: 'single', names: ['王'] }])
    assert.ok(r.scope.includes('seed-entity-mentions:0'))
  })
  await test('native-entities-obey-access-review-and-transaction-time', async () => {
    const f = await createL2EntityTimeFixture(), p = f.projection.snapshot()!, c = f.personClaim('lin')
    for (const change of [ { sharePolicy: 'local-only' as const }, { sensitivity: 'secret' as const },
      { review: { status: 'candidate' as const } }, { transactionTime: { recordedAt: at + 1000, closedAt: null } },
      { transactionTime: { recordedAt: at, closedAt: at + 1 } }, { scope: { ...scope, ownerId: 'other' } } ]) {
      const next = { ...p, semanticBundle: { ...p.semanticBundle,
        entities: p.semanticBundle.entities.map(e => e.ref.id === 'lin' ? { ...e, ...change } : e) } }
      assert.ok(!entityCandidateBindings(c, next, ['allow-remote'], ['normal'], at + 100).some(b => b.names.includes('林同学')))
    }
  })
  await test('native-time-and-person-filter-survives-maximal-similarity', async () => {
    const f = await createL2EntityTimeFixture(), before = JSON.stringify(f.relations.snapshot())
    f.options.semantic = { model: 'toy-identity', dimensions: 2, index: { get: () => [1, 0] },
      embedQuery: async () => ({ model: 'toy-identity', vector: [1, 0] }) }
    const port = createV4L2Memory(f.options)
    for (const [query, person] of [['昨天林同学相关的记忆', 'lin'], ['今天林同学相关的记忆', null],
      ['今天周同学相关的记忆', 'zhou'], ['昨天周同学相关的记忆', null]] as const) {
      const r = ok(await port.recall(f.request(query)))
      assert.deepEqual(r.trace.candidateRefs, person ? [f.personClaim(person).ref] : [])
      assert.deepEqual(r.evidence.claims.map(c => c.ref), person ? [f.personClaim(person).ref] : [])
      assert.equal(r.evidence.relations!.length, 0)
    }
    assert.equal(JSON.stringify(f.relations.snapshot()), before)
  })
  await test('scope-and-historical-rejections-happen-before-embedding', async () => {
    const f = await createL2EntityTimeFixture(); let calls = 0
    f.options.semantic = { model: 'toy', dimensions: 2, index: { get: () => [1, 0] },
      embedQuery: async () => { calls++; return { model: 'toy', vector: [1, 0] } } }
    const port = createV4L2Memory(f.options), request = f.request('今天林同学相关的记忆')
    assert.equal((await port.recall({ ...request, scope: { ...scope, ownerId: 'other' } })).ok, false)
    assert.equal((await port.recall({ ...request, temporal: { ...request.temporal, knownAt: at - 1 } })).ok, false)
    assert.equal(calls, 0)
  })
  await test('shared-alias-remains-ambiguous-across-a-date-range-in-the-agent-prompt', async () => {
    const f = await createL2EntityTimeFixture()
    const r = ok(await createV4L2Memory(f.options).recall(f.request('2026-09-26到2026-09-27同学相关的记忆')))
    assert.equal(r.trace.candidateRefs.length, 2)
    assert.ok(r.trace.searchScope.includes('seed-entity-target:ambiguous-identity'))
    if (validatePrompt) assert.ok(validatePrompt(r).includes('multiple distinct entity identities'))
  })
  await test('source-denial-does-not-build-an-entity-catalog-or-call-embedding', async () => {
    const f = await createL2EntityTimeFixture(); let calls = 0
    f.deny(); f.options.semantic = { model: 'toy', dimensions: 2, index: { get: () => [1, 0] },
      embedQuery: async () => { calls++; return { model: 'toy', vector: [1, 0] } } }
    const r = ok(await createV4L2Memory(f.options).recall(f.request('今天林同学相关的记忆')))
    assert.deepEqual(r.evidence.claims, []); assert.equal(calls, 0)
    assert.ok(r.trace.searchScope.includes('seed-entity-mentions:0'))
  })
  return { tests: checks.length, passed: checks.filter(c => c.passed).length, checks }
}
