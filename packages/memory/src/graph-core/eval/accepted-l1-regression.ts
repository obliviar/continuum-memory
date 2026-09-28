import assert from 'node:assert/strict'
import type { GraphRecallRequest, GraphResult } from '@continuum-memory/contracts'
import { createMemoryV4Repository } from '../../v4/repository/memory-v4-repository'
import { createGraphExtractionRun, type FactContext } from '../../long-term/graph-extraction-result'
import { createGraphPredicateRegistry, normalizeGraphExtraction } from '../../long-term/graph-identity-normalization'
import { assessGraphClaim, confirmGraphClaim, createGraphL1Store, createGraphL1Writer } from '../../long-term/graph-l1-write'
import { createGraphSemanticRepository } from '../repository/semantic-repository'
import { createGraphL1ProjectionRepository } from '../repository/l1-projection-repository'
import { createV4GraphMemory, selectRetrievableGraphBundle, V4_GRAPH_BUDGET } from '../adapters/v4-graph-memory'
import { V4_SCALAR_MAPPING_POLICY } from '../adapters/v4-semantic-adapter'
import { collectCurrentL1 } from '../adapters/accepted-l1-input'
import { createV4L2Memory } from '../adapters/v4-l2-memory'

const scope = { ownerId: 'owner', agentId: 'agent' }, at = 1_800_000_000_000
const entities = [
  { ref: { kind: 'entity' as const, id: 'alex', version: 3 }, scope, entityType: 'person', canonicalName: 'Alexander', aliases: ['Alex', 'AlfredAlias'] },
  { ref: { kind: 'entity' as const, id: 'acme', version: 2 }, scope, entityType: 'organization', canonicalName: 'Acme Corporation', aliases: ['Acme'] },
]
const context: FactContext = { negation: { value: false, resolution: 'resolved' },
  condition: { value: null, resolution: 'absent' }, time: { value: '2026-09-26', resolution: 'resolved' },
  speaker: { value: null, resolution: 'absent' } }
function memory() { let data: string | undefined; return { load: () => data, save: (s: string) => { data = s } } }
function value<T>(r: GraphResult<T>): T { if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`); return r.value }

async function fixture(customContext = context, publish = true) {
  const repository = createMemoryV4Repository({ now: () => at }), l1 = createGraphL1Store(memory())
  const semantic = createGraphSemanticRepository(memory(), repository), registry = createGraphPredicateRegistry()
  const projection = createGraphL1ProjectionRepository(memory(), semantic, repository, l1)
  const sync = async () => { value(await semantic.syncFromClaims(l1, repository, registry, scope)); assert(projection.sync()) }
  const writer = createGraphL1Writer(repository, l1, registry, scope, { syncFromClaims: sync })
  const run = createGraphExtractionRun({ sourceId: 'fixture-message', sourceText: 'Alex works at Acme', modelId: 'synthetic', rawOutput: {
    graph: { entities: [
      { id: 'p', type: 'person', text: 'Alex', span: { start: 0, end: 4 }, modelScore: 0.91 },
      { id: 'o', type: 'organization', text: 'Acme', span: { start: 14, end: 18 }, modelScore: 0.91 }],
    facts: [{ id: 'f', subjectMentionId: 'p', predicate: 'works at', object: { mentionId: 'o' },
      evidenceSpan: { start: 0, end: 18 }, modelScore: 0.91, context: customContext }] } } })
  const fact = normalizeGraphExtraction(run, { entities, scope }).facts[0]!
  const review = confirmGraphClaim(assessGraphClaim(run, fact, { sensitivity: 'normal', sharePolicy: 'allow-remote' }, at),
    'Synthetic fixture source checked', at)
  if (publish) assert.equal((await writer.submit(run, fact, review, entities))?.state, 'published')
  let retain = true, readable = true
  const persistence = memory()
  const access = { accessContextId: 'test', authorizationVersion: '1', scope,
    sharePolicies: ['allow-remote' as const], sensitivities: ['normal' as const] }
  const options = { repository, persistence, now: () => at, countTokens: (s: string) => Buffer.byteLength(s),
    authorizeScope: (s: typeof scope) => s.ownerId === scope.ownerId && s.agentId === scope.agentId && !('sessionId' in s),
    canRead: () => readable, resolveGraphAccess: () => access,
    acceptedBundle: () => selectRetrievableGraphBundle(projection.snapshot()?.semanticBundle,
      l1.tasks().map(t => ({ ...t, review: { ...t.review, retrieval: { ...t.review.retrieval, retain } } }))) }
  const graph = createV4GraphMemory(options)
  const request: GraphRecallRequest = { protocolVersion: 'memory-graph/v1', recallId: 'test', query: 'Acme', scope,
    temporal: { knownAt: at, valid: { kind: 'at', at: Date.UTC(2026, 8, 26, 12) } }, mode: 'direct-only',
    budget: { ...V4_GRAPH_BUDGET }, sharePolicies: ['allow-remote'], sensitivities: ['normal'] }
  const open = () => graph.l1.openView({ access, temporal: request.temporal, budget: request.budget,
    expectedManifestId: graph.l1.snapshot()!.manifest.manifestId, policyVersion: V4_SCALAR_MAPPING_POLICY })
  return { repository, l1, graph, options, request, open, sync, projection, persistence,
    withdraw: () => { retain = false }, deny: () => { readable = false } }
}

export async function runAcceptedL1Regression(prepareGraphRecallInputs: (options: {
  flushCaptures: () => Promise<void>; flushV4: () => void; syncL1: () => Promise<void>; isCurrent: () => boolean
}) => Promise<void>) {
  const checks: { id: string; passed: boolean; error?: string }[] = []
  async function test(id: string, fn: () => Promise<void>) {
    try { await fn(); checks.push({ id, passed: true }) } catch (e) { checks.push({ id, passed: false, error: String(e) }) }
  }
  await test('native-writer-to-fixed-view-source-and-exact-entity', async () => {
    const f = await fixture(), r = value(await f.graph.recall(f.request))
    assert.equal(r.evidence.claims.length, 1); assert.deepEqual(r.evidence.claims[0]!.ref, f.l1.claims()[0]!.ref)
    const view = value(await f.open()), claim = f.l1.claims()[0]!
    assert.equal(value(await f.graph.l1.evidenceReader.readSources(view, claim.provenance.sources))[0]!.content, 'Alex works at Acme')
    assert.equal(value(await view.resolveEntities!([entities[0]!.ref]))[0]!.canonicalName, 'Alexander')
    assert.equal((await view.resolveEntities!([{ ...entities[0]!.ref, version: 2 }])).ok, false)
    await view.close()
  })
  await test('entity-alias-finds-claim-without-rewriting-identity', async () => {
    const f = await fixture(), r = value(await f.graph.recall({ ...f.request, query: 'AlfredAlias' }))
    assert.equal(r.evidence.claims.length, 1); assert.deepEqual(r.evidence.claims[0]!.ref, f.l1.claims()[0]!.ref)
  })
  await test('unpublished-extraction-is-not-answer-evidence', async () => {
    const f = await fixture(context, false); assert.equal(value(await f.graph.recall(f.request)).evidence.claims.length, 0)
  })
  await test('withdrawal-invalidates-pinned-view-and-hides-evidence', async () => {
    const f = await fixture(); value(await f.graph.recall(f.request)); const view = value(await f.open())
    f.withdraw(); assert.equal((await view.resolveClaims([f.l1.claims()[0]!.ref])).ok, false)
    assert.equal(value(await f.graph.recall(f.request)).evidence.claims.length, 0); await view.close()
  })
  await test('graph-origin-scalar-cannot-bypass-consent', async () => {
    const { createV4GraphTestRepository } = await import('../fixtures/v4-direct-memory')
    const repository = createV4GraphTestRepository()
    repository.transaction(s => { s.facts[0]!.metadata = { graphTaskId: 'unretained-task' } })
    const result = collectCurrentL1({ repository, canRead: () => true }, { ownerId: 'owner', agentId: 'agent' }, 200)
    assert.equal(result.inputs.length, 0)
  })
  await test('source-deletion-and-content-update-revoke-native-claim', async () => {
    for (const deletion of [false, true]) {
      const f = await fixture(); value(await f.graph.recall(f.request)); const view = value(await f.open())
      f.repository.transaction(s => { if (deletion) { s.episodes[0]!.contentState = 'deleted'; s.episodes[0]!.deletedAt = at; delete s.episodes[0]!.content }
        else s.episodes[0]!.content = 'Changed source' })
      assert.equal((await view.resolveClaims([f.l1.claims()[0]!.ref])).ok, false)
      assert.equal(value(await f.graph.recall(f.request)).evidence.claims.length, 0); await view.close()
    }
  })
  await test('privacy-and-owner-isolation', async () => {
    const f = await fixture()
    assert.equal(value(await f.graph.recall({ ...f.request, sharePolicies: ['local-only'] })).evidence.claims.length, 0)
    assert.equal((await f.graph.recall({ ...f.request, scope: { ...scope, ownerId: 'other' } })).ok, false)
    f.deny(); assert.equal(value(await f.graph.recall(f.request)).evidence.claims.length, 0)
  })
  await test('unknown-time-kept-explicit-only-in-undated-source-recall', async () => {
    const f = await fixture({ ...context, time: { value: null, resolution: 'unresolved' }, negation: { value: null, resolution: 'unresolved' } })
    const r = value(await f.graph.recall({ ...f.request, temporal: { knownAt: at, valid: { kind: 'at', at } } }))
    assert.equal(r.evidence.claims.length, 1); assert.equal(r.evidence.claims[0]!.validTime.kind, 'unknown')
    assert.equal(r.evidence.claims[0]!.polarity, 'unknown'); assert.equal(r.trace.completeness, 'incomplete')
    assert.equal(value(await f.graph.recall({ ...f.request, query: '2026-09-26 Acme' })).evidence.claims.length, 0)
  })
  await test('conditional-source-retains-condition', async () => {
    const f = await fixture({ ...context, condition: { value: 'if hired', resolution: 'resolved' } })
    const r = value(await f.graph.recall(f.request)); assert.equal(r.evidence.claims.length, 1)
    assert.equal(r.evidence.claims[0]!.conditionText, 'if hired'); assert.equal(r.trace.completeness, 'incomplete')
  })
  await test('reload-keeps-native-exact-manifest', async () => {
    const f = await fixture(), first = value(await f.graph.recall(f.request))
    const second = value(await createV4GraphMemory(f.options).recall(f.request)); assert.equal(second.manifestId, first.manifestId)
  })
  await test('withdrawal-during-semantic-await-cannot-deliver-old-evidence', async () => {
    const f = await fixture()
    const graph = createV4GraphMemory({ ...f.options, semantic: { model: 'test', dimensions: 2,
      index: { get: () => [1, 0] }, embedQuery: async () => { f.withdraw(); return { model: 'test', vector: [1, 0] } } } })
    assert.equal((await graph.recall(f.request)).ok, false)
  })
  await test('duplicate-entity-name-is-not-an-identity-merge', async () => {
    const f = await fixture(); value(await f.graph.recall(f.request)); const view = value(await f.open())
    assert.equal((await view.resolveEntities!([{ kind: 'entity', id: 'different-alex', version: 3 }])).ok, false)
    await view.close()
  })
  await test('native-source-span-cannot-be-widened-by-caller', async () => {
    const f = await fixture(); value(await f.graph.recall(f.request)); const view = value(await f.open())
    const source = f.l1.claims()[0]!.provenance.sources[0]!
    assert.equal((await f.graph.l1.evidenceReader.readSources(view, [{ ...source, locator: { kind: 'whole-content' } }])).ok, false)
    await view.close()
  })
  await test('unpublished-native-projection-revokes-read-view', async () => {
    const f = await fixture(); value(await f.graph.recall(f.request)); const view = value(await f.open())
    f.projection.invalidate()
    assert.equal((await view.resolveEntities!([entities[0]!.ref])).ok, false)
    assert.equal(value(await f.graph.recall(f.request)).evidence.claims.length, 0); await view.close()
  })
  await test('native-l1-enters-l2-preparation-with-original-refs', async () => {
    const f = await fixture(), port = createV4L2Memory({ ...f.options, relationPersistence: memory() })
    const prepared = value(port.prepareRelations(scope)), projection = prepared.core.l1.snapshot()!
    assert.deepEqual(projection.semanticBundle.claims[0]!.ref, f.l1.claims()[0]!.ref)
    assert.equal(prepared.repository.snapshot().manifest.coreManifestId, projection.manifest.manifestId)
    assert.equal(prepared.repository.snapshot().relations.length, 0)
    f.withdraw(); assert.equal(prepared.core.l1.snapshot()!.manifest.state, 'stale')
  })
  await test('owner-wide-opt-in-does-not-authorize-another-owner-or-session', async () => {
    const { createV4GraphTestRepository } = await import('../fixtures/v4-direct-memory')
    const repository = createV4GraphTestRepository()
    repository.transaction(s => { s.facts[0]!.scope = { ...scope, sessionId: 'old' }; s.episodes[0]!.scope = { ...scope, sessionId: 'old' } })
    const options = { repository, canRead: () => true }
    assert.equal(collectCurrentL1(options, scope, 200).inputs.length, 0)
    assert.equal(collectCurrentL1({ ...options, includeOwnedSessions: true }, scope, 200).inputs.length, 1)
    assert.equal(collectCurrentL1({ ...options, includeOwnedSessions: true }, { ...scope, ownerId: 'other' }, 200).inputs.length, 0)
    assert.equal(collectCurrentL1({ ...options, includeOwnedSessions: true }, { ...scope, sessionId: 'different' }, 200).inputs.length, 0)
  })
  await test('capture-barrier-refreshes-native-projection-after-v4-write', async () => {
    const f = await fixture(), events: string[] = []
    await prepareGraphRecallInputs({ isCurrent: () => true,
      flushCaptures: async () => { events.push('capture') },
      flushV4: () => { events.push('v4'); f.repository.transaction(s => { s.facts[0]!.accessCount++ }) },
      syncL1: async () => { events.push('l1'); assert.equal(f.projection.snapshot(), undefined); await f.sync() } })
    assert.deepEqual(events, ['capture', 'v4', 'l1'])
    assert.equal(value(await f.graph.recall(f.request)).evidence.claims.length, 1)
  })
  await test('capture-barrier-stops-on-reload-or-failed-write', async () => {
    let current = true, called = false
    await assert.rejects(prepareGraphRecallInputs({ isCurrent: () => current,
      flushCaptures: async () => { current = false }, flushV4: () => { called = true }, syncL1: async () => { called = true } }))
    assert.equal(called, false)
    await assert.rejects(prepareGraphRecallInputs({ isCurrent: () => true,
      flushCaptures: async () => {}, flushV4: () => { throw new Error('write failed') }, syncL1: async () => { called = true } }))
    assert.equal(called, false)
  })
  return { tests: checks.length, passed: checks.filter(c => c.passed).length, checks }
}
