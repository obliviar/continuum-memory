import assert from 'node:assert/strict'
import type { GraphRecallRequest, GraphRecallResult, GraphResult } from '@continuum-memory/contracts'
import { createV4GraphTestRepository, V4_TEST_SCOPE as scope } from '../fixtures/v4-direct-memory'
import { createV4L2Memory, V4_L2_BUDGET, invalidateV4RelationCheckpoint } from '../adapters/v4-l2-memory'
import type { GraphRelationRecord } from '../domain/relation-types'
import { createV4RelationSourceReader } from '../adapters/v4-relation-sources'
import { createGraphRelationRepository } from '../repository/relation-repository'

function ok<T>(r: GraphResult<T>): T { if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`); return r.value }
function failed(r: GraphResult<unknown>, code?: string) { assert.equal(r.ok, false); if (!r.ok && code) assert.equal(r.error.code, code) }
export function createL2HostFixture() {
  const repository = createV4GraphTestRepository()
  repository.transaction(s => {
    s.episodes[0]!.content = '下雨导致比赛取消。下雨在比赛取消之前。'
    for (const row of [s.facts[0]!, s.factVersions[0]!]) Object.assign(row,
      { canonicalText: '下雨', predicate: 'event.rain', object: '下雨', normalizedValue: '下雨' })
    s.evidenceLinks.push({ ...s.evidenceLinks[0]!, id: 'ev2', factId: 'f2' })
    s.facts.push({ ...s.facts[0]!, id: 'f2', canonicalText: '比赛取消', predicate: 'event.cancel',
      object: '比赛取消', normalizedValue: '比赛取消', evidenceLinkIds: ['ev2'] })
    s.factVersions.push({ ...s.factVersions[0]!, id: 'v2', factId: 'f2', canonicalText: '比赛取消',
      predicate: 'event.cancel', object: '比赛取消', normalizedValue: '比赛取消', evidenceLinkIds: ['ev2'] })
  })
  let l1: string | undefined, l2: string | undefined, allow = true
  const options = { repository, persistence: { load: () => l1, save: (p: string) => { l1 = p } },
    relationPersistence: { load: () => l2, save: (p: string) => { l2 = p } },
    canRead: () => allow, authorizeScope: (s: typeof scope) => s.ownerId === scope.ownerId && s.agentId === scope.agentId,
    countTokens: (s: string) => Buffer.byteLength(s), now: () => 200 }
  const port = createV4L2Memory(options)
  const request = (query = '为什么比赛取消'): GraphRecallRequest => ({ protocolVersion: 'memory-graph/v1', recallId: query, query,
    scope, temporal: { knownAt: 200, valid: { kind: 'at', at: 200 } }, mode: 'direct-only',
    budget: { ...V4_L2_BUDGET }, sharePolicies: ['local-only'], sensitivities: ['normal'] })
  async function publish(kinds: GraphRelationRecord['kind'][] = ['causes', 'precedes']) {
    const prepared = ok(port.prepareRelations(scope))
    const snapshot = prepared.repository.snapshot()
    const [from, to] = prepared.core.l1.snapshot()!.semanticBundle.claims
    assert.deepEqual(from!.context, to!.context)
    const relations: GraphRelationRecord[] = kinds.map(kind => ({ ref: { kind: 'relation', id: kind, version: 1 },
      from: from!.ref, to: to!.ref, kind, context: from!.context, scope, polarity: 'positive', modality: 'asserted',
      validTime: { kind: 'interval', from: 100, to: null }, assertionBasis: 'source-explicit',
      transactionTime: { recordedAt: 100, closedAt: null }, review: { status: 'accepted', reviewedAt: 100, reviewer: 'test-human' },
      provenance: from!.provenance, evidence: [{ source: from!.provenance.sources[0]!, role: 'supports' }],
      sensitivity: 'normal', sharePolicy: 'local-only', nliObservationIds: [] }))
    ok(await prepared.repository.publish({ operationId: 'reviewed-test-relations', expectedManifestId: snapshot.manifest.manifestId,
      snapshot: { ...snapshot, manifest: { ...snapshot.manifest, manifestId: 'accepted-test-l2', relationRevision: 1 }, relations } }))
    return prepared
  }
  return { repository, options, port, request, publish, deny: () => { allow = false } }
}

export async function runL2HostRegression(validatePrompt?: (result: GraphRecallResult) => string) {
  const fixture = createL2HostFixture
  const checks: { id: string; passed: boolean; error?: string }[] = []
  async function test(id: string, action: () => Promise<void>) {
    try { await action(); checks.push({ id, passed: true }) }
    catch (e) { checks.push({ id, passed: false, error: String(e) }) }
  }
  for (const [query, direction, kind] of [
    ['为什么比赛取消', 'in', 'causes'], ['下雨导致什么', 'out', 'causes'],
    ['比赛取消之前发生了什么', 'in', 'precedes'], ['下雨之后发生了什么', 'out', 'precedes'],
  ]) await test(`question-route:${query}`, async () => {
    const f = fixture(); await f.publish(); const r = ok(await f.port.recall(f.request(query)))
    assert.equal(r.evidence.relations?.length, 1); assert.equal(r.evidence.relations![0]!.kind, kind)
    assert.equal(r.evidence.claims.length, 2); assert.ok(r.trace.searchScope.includes(`direction:${direction}`))
    assert.equal(r.evidence.proofs.length, 0); assert.equal(r.trace.completeness, 'incomplete')
    const texts = new Map(r.evidence.claims.map(c => [c.ref.id, c.content]))
    assert.equal(texts.get(r.evidence.relations![0]!.from.id), '下雨')
    assert.equal(texts.get(r.evidence.relations![0]!.to.id), '比赛取消')
    if (validatePrompt) assert.ok(validatePrompt(r).includes('"relations"'))
  })
  await test('accepted-relations-survive-host-restart', async () => {
    const f = fixture(); await f.publish()
    assert.equal(ok(await createV4L2Memory(f.options).recall(f.request())).evidence.relations?.length, 1)
  })
  await test('concurrent-host-publications-do-not-overwrite-the-winner', async () => {
    const f = fixture(); await f.publish()
    const a = ok(f.port.prepareRelations(scope)).repository
    const b = ok(f.port.prepareRelations(scope)).repository
    const base = a.snapshot()
    const publish = (repository: typeof a, id: string) => repository.publish({ operationId: id,
      expectedManifestId: base.manifest.manifestId, snapshot: { ...base,
        manifest: { ...base.manifest, manifestId: id, relationRevision: base.manifest.relationRevision + 1 },
        relations: base.relations.map((relation, index) => index === 0
          ? { ...relation, transactionTime: { ...relation.transactionTime, closedAt: id === 'writer-a' ? 150 : 160 } }
          : relation) } })
    const results = await Promise.all([publish(a, 'writer-a'), publish(b, 'writer-b')])
    assert.equal(results.filter(r => r.ok).length, 1, JSON.stringify(results))
    failed(results.find(r => !r.ok)!, 'version-mismatch')
    const winner = ok(results.find(r => r.ok)!).manifestId
    const stored = JSON.parse(f.options.relationPersistence.load()!)
    assert.equal(stored.manifest.manifestId, winner)
    assert.deepEqual(stored.relations.map((r: GraphRelationRecord) => r.ref.id), ['causes', 'precedes'])
    assert.equal(stored.relations[0].transactionTime.closedAt, winner === 'writer-a' ? 150 : 160)
    assert.deepEqual(stored.relations[1], base.relations[1])
    assert.equal((winner === 'writer-a' ? b : a).snapshot().manifest.state, 'stale')
  })
  await test('stale-instance-cannot-invalidate-or-purge-newer-relations', async () => {
    const f = fixture(); await f.publish()
    const old = ok(f.port.prepareRelations(scope)).repository, base = old.snapshot()
    invalidateV4RelationCheckpoint(f.options.relationPersistence)
    const saved = f.options.relationPersistence.load()
    failed(await old.invalidate({ operationId: 'old-invalidate', scope,
      expectedManifestId: base.manifest.manifestId, nextManifestId: 'old-stale', reason: 'source-changed' }), 'version-mismatch')
    failed(await old.purge({ operationId: 'old-purge', scope, expectedManifestId: base.manifest.manifestId,
      nextManifestId: 'old-purged', sourceVersions: base.relations[0]!.provenance.sources, claimVersions: [] }), 'version-mismatch')
    assert.equal(f.options.relationPersistence.load(), saved)
    assert.equal(old.snapshot().manifest.state, 'stale')
  })
  await test('publication-uses-the-validated-copy-during-source-await', async () => {
    const f = fixture(); const p = await f.publish(), base = p.repository.snapshot()
    const next = structuredClone({ ...base, manifest: { ...base.manifest, manifestId: 'validated-copy' } })
    const publishing = p.repository.publish({ operationId: 'mutation-test', expectedManifestId: base.manifest.manifestId, snapshot: next })
    Reflect.set(next.relations[0]!.ref, 'id', 'not-validated')
    ok(await publishing)
    assert.equal(JSON.parse(f.options.relationPersistence.load()!).relations[0].ref.id, 'causes')
  })
  await test('external-invalidation-during-source-check-blocks-publication', async () => {
    const f = fixture(); const p = await f.publish()
    const repository = createGraphRelationRepository({ coreSnapshot: () => p.core.l1.snapshot()!,
      persistence: f.options.relationPersistence, now: () => 200, verifySources: async () => {
        invalidateV4RelationCheckpoint(f.options.relationPersistence)
        return { ok: true, value: undefined }
      } })
    const base = repository.snapshot()
    failed(await repository.publish({ operationId: 'invalidated-during-check', expectedManifestId: base.manifest.manifestId,
      snapshot: { ...base, manifest: { ...base.manifest, manifestId: 'must-not-publish' } } }), 'version-mismatch')
    assert.equal(JSON.parse(f.options.relationPersistence.load()!).manifest.state, 'stale')
  })
  await test('failed-persistence-preserves-the-last-published-relations', async () => {
    const f = fixture(); const p = await f.publish(), saved = f.options.relationPersistence.load()
    const repository = createGraphRelationRepository({ coreSnapshot: () => p.core.l1.snapshot()!,
      persistence: { load: f.options.relationPersistence.load, save: () => { throw new Error('disk failed') } },
      verifySources: async () => ({ ok: true, value: undefined }) })
    const base = repository.snapshot()
    await assert.rejects(repository.publish({ operationId: 'failed-write', expectedManifestId: base.manifest.manifestId,
      snapshot: { ...base, manifest: { ...base.manifest, manifestId: 'failed-write' } } }), /disk failed/)
    assert.deepEqual(repository.snapshot(), base)
    assert.equal(f.options.relationPersistence.load(), saved)
  })
  await test('current-instance-can-invalidate-then-purge-source-relations', async () => {
    const f = fixture(); const p = await f.publish(), base = p.repository.snapshot()
    ok(await p.repository.invalidate({ operationId: 'invalidate', scope, expectedManifestId: base.manifest.manifestId,
      nextManifestId: 'invalidated', reason: 'source-deleted' }))
    const result = ok(await p.repository.purge({ operationId: 'purge', scope, expectedManifestId: 'invalidated',
      nextManifestId: 'purged', sourceVersions: base.relations[0]!.provenance.sources, claimVersions: [] }))
    assert.equal(result.removedRelations, 2)
    assert.equal(p.repository.snapshot().manifest.relationRevision, base.manifest.relationRevision + 1)
    assert.deepEqual(JSON.parse(f.options.relationPersistence.load()!).relations, [])
  })
  await test('empty-store-does-not-invent-relations', async () => {
    const f = fixture(); const r = ok(await f.port.recall(f.request()))
    assert.equal(r.evidence.relations!.length, 0); assert.ok(r.trace.searchScope.includes('no-eligible-relation-evidence'))
  })
  await test('pending-candidate-is-not-answer-evidence', async () => {
    const f = fixture(), p = ok(f.port.prepareRelations(scope)), snapshot = p.repository.snapshot()
    const [from, to] = p.core.l1.snapshot()!.semanticBundle.claims
    ok(await p.repository.publish({ operationId: 'candidate-only', expectedManifestId: snapshot.manifest.manifestId,
      snapshot: { ...snapshot, manifest: { ...snapshot.manifest, manifestId: 'candidate-only', candidateRevision: 1 },
        candidates: [{ id: 'pending', scope, from: from!.ref, to: to!.ref, context: from!.context,
          kind: 'causes', validTime: from!.validTime, sourceHints: from!.provenance.sources,
          hypothesisText: '下雨导致比赛取消', generator: { route: 'source-cue', version: 'test' }, resolution: { status: 'pending' } }] } }))
    assert.equal(ok(await f.port.recall(f.request())).evidence.relations!.length, 0)
  })
  await test('different-source-contexts-are-not-automatically-merged', async () => {
    const f = fixture()
    f.repository.transaction(s => {
      s.episodes.push({ ...s.episodes[0]!, id: 'ep2' })
      s.evidenceLinks.find(e => e.id === 'ev2')!.episodeId = 'ep2'
    })
    const p = ok(f.port.prepareRelations(scope)), claims = p.core.l1.snapshot()!.semanticBundle.claims
    assert.notDeepEqual(claims[0]!.context, claims[1]!.context)
  })
  await test('zero-hop-budget-never-traverses-a-relation', async () => {
    const f = fixture(); await f.publish()
    const r = ok(await f.port.recall({ ...f.request(), budget: { ...V4_L2_BUDGET, maxHops: 0 } }))
    assert.equal(r.evidence.relations!.length, 0); assert.equal(r.trace.stopReason, 'hop-budget')
  })
  await test('prompt-rejects-relation-with-missing-endpoint', async () => {
    if (!validatePrompt) return
    const f = fixture(); await f.publish(); const r = ok(await f.port.recall(f.request()))
    assert.throws(() => validatePrompt({ ...r, evidence: { ...r.evidence, claims: [] } }))
  })
  await test('source-change-marks-L2-stale-without-silent-rebinding', async () => {
    const f = fixture(); await f.publish(); f.repository.transaction(s => { s.episodes[0]!.content += '补充说明。' })
    failed(await f.port.recall(f.request()), 'stale-projection')
    assert.equal(JSON.parse(f.options.relationPersistence.load()!).manifest.state, 'stale')
  })
  await test('deleted-source-cannot-revive-through-L2', async () => {
    const f = fixture(); await f.publish(); f.repository.transaction(s => {
      s.episodes[0]!.deletedAt = 150; s.episodes[0]!.contentState = 'deleted'; delete s.episodes[0]!.content
    }); failed(await f.port.recall(f.request()), 'stale-projection')
  })
  await test('source-policy-revocation-blocks-relations', async () => {
    const f = fixture(); await f.publish(); f.deny(); failed(await f.port.recall(f.request()), 'stale-projection')
  })
  await test('request-policy-filter-does-not-leak-L2', async () => {
    const f = fixture(); await f.publish(); const r = ok(await f.port.recall({ ...f.request(), sharePolicies: ['allow-remote'] }))
    assert.equal(r.evidence.claims.length, 0); assert.equal(r.evidence.relations!.length, 0)
  })
  await test('scope-isolation', async () => {
    const f = fixture(); await f.publish(); failed(await f.port.recall({ ...f.request(), scope: { ...scope, ownerId: 'other' } }), 'scope-denied')
  })
  await test('small-output-budget-rejects-whole-evidence-group', async () => {
    const f = fixture(); await f.publish(); const r = await f.port.recall({ ...f.request(), budget: { ...V4_L2_BUDGET, maxEvidenceTokens: 1 } })
    failed(r, 'budget-exhausted')
  })
  await test('ordinary-direct-recall-still-works', async () => {
    const f = fixture(); const r = ok(await f.port.recall(f.request('下雨')))
    assert.equal(r.evidence.claims[0]!.content, '下雨'); assert.equal(r.evidence.relations, undefined)
  })
  await test('lifecycle-invalidation-revokes-persisted-view', async () => {
    const f = fixture(); await f.publish(); invalidateV4RelationCheckpoint(f.options.relationPersistence)
    failed(await f.port.recall(f.request()), 'stale-projection')
  })
  await test('source-reader-rejects-hash-and-span-forgery', async () => {
    const f = fixture(); const p = await f.publish(), c = p.core.l1.snapshot()!.semanticBundle.claims[0]!
    const reader = createV4RelationSourceReader(f.options)
    const access = { accessContextId: 'test', authorizationVersion: '1', scope,
      sharePolicies: ['local-only' as const], sensitivities: ['normal' as const] }
    failed(reader.read([{ ...c.provenance.sources[0]!, contentHash: 'forged' }], access), 'source-unavailable')
    failed(reader.read([{ ...c.provenance.sources[0]!, locator: { kind: 'text-span', unit: 'utf16', start: 0, end: 999 } }], access), 'source-unavailable')
  })
  return { kind: 'real-V4-L1-L2-host-path-with-synthetic-reviewed-relations', checks }
}
