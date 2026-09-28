import assert from 'node:assert/strict'
import { createV4GraphTestRepository, V4_TEST_SCOPE as scope } from '../fixtures/v4-direct-memory'
import { createV4L1Store } from '../repository/v4-l1-store'
import { createV4GraphMemory, V4_GRAPH_BUDGET } from '../adapters/v4-graph-memory'
import { V4_SCALAR_MAPPING_POLICY } from '../adapters/v4-semantic-adapter'
import { createGraphRelationRepository } from '../repository/relation-repository'
import { createGraphRelationReadPort } from '../repository/relation-read-port'
import type { GraphAccessContext, GraphOpenViewRequest } from '../ports/graph-ports'
import type { GraphResult, GraphRecallRequest } from '@continuum-memory/contracts'

function ok<T>(result: GraphResult<T>): T { if (!result.ok) throw new Error(result.error.code); return result.value }
function denied(result: GraphResult<unknown>, code: string) { assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, code) }
function fixture() {
  const repository = createV4GraphTestRepository()
  let disk: string | undefined, allow = true, saves = 0
  let grant: GraphAccessContext | undefined = { accessContextId: 'host-grant', authorizationVersion: '1', scope,
    sharePolicies: ['local-only'], sensitivities: ['normal'] }
  const access = structuredClone(grant)
  const options = { repository, persistence: { load: () => disk, save: (s: string) => { disk = s; saves++ } },
    authorizeScope: (s: typeof scope) => s.ownerId === scope.ownerId && s.agentId === scope.agentId,
    canRead: () => allow, countTokens: (s: string) => Buffer.byteLength(s), now: () => 200,
    resolveAccess: (id: string) => id === grant?.accessContextId ? grant : undefined }
  const store = createV4L1Store(options)
  const publish = () => store.publishCurrent({ operationId: 'p', scope, expectedManifestId: store.snapshot()?.manifest.manifestId ?? null })
  const request = (): GraphOpenViewRequest => ({ access, expectedManifestId: store.snapshot()!.manifest.manifestId,
    policyVersion: V4_SCALAR_MAPPING_POLICY, temporal: { knownAt: 200, valid: { kind: 'at', at: 200 } }, budget: { ...V4_GRAPH_BUDGET } })
  const open = async () => ok(await store.openView(request()))
  return { repository, options, store, publish, request, open, access, saves: () => saves, disk: () => disk,
    deny: () => { allow = false }, revoke: () => { grant = undefined },
    rotate: () => { grant = { ...access, authorizationVersion: '2' } },
    setDisk: (s: string) => { disk = s } }
}

export async function runL1ViewRegression() {
  const checks: { id: string; passed: boolean; error?: string }[] = []
  async function test(id: string, run: () => Promise<void> | void) {
    try { await run(); checks.push({ id, passed: true }) }
    catch (e) { checks.push({ id, passed: false, error: String(e) }) }
  }
  await test('exact-claim-fact-source-roundtrip', async () => {
    const f = fixture(); ok(f.publish()); const view = await f.open()
    const claim = f.store.snapshot()!.semanticBundle.claims[0]!
    assert.deepEqual(ok(await view.resolveClaims([claim.ref])), [claim])
    assert.equal(ok(await f.store.evidenceReader.resolveFactVersions(view, [claim.fact]))[0]!.canonicalText, 'I like tea')
    assert.equal(ok(await f.store.evidenceReader.readSources(view, claim.provenance.sources))[0]!.content, 'I like tea')
    await view.close()
  })
  await test('idempotent-publication-keeps-view-live', async () => {
    const f = fixture(); ok(f.publish()); const view = await f.open(); ok(f.publish())
    assert.equal(f.saves(), 1); assert.equal(await f.store.isViewLive(view.viewId), true)
  })
  await test('reload-same-fixed-manifest', async () => {
    const f = fixture(); ok(f.publish()); const second = createV4L1Store(f.options)
    assert.deepEqual(second.snapshot(), f.store.snapshot()); ok(await second.openView(f.request()))
  })
  await test('two-instance-CAS-rejects-lost-update', () => {
    const f = fixture(); const second = createV4L1Store(f.options); ok(f.publish())
    denied(second.publishCurrent({ operationId: 'p2', scope, expectedManifestId: null }), 'version-mismatch')
  })
  await test('wrong-expected-manifest-rejected', () => {
    const f = fixture(); ok(f.publish())
    denied(f.store.publishCurrent({ operationId: 'p2', scope, expectedManifestId: 'wrong' }), 'version-mismatch')
  })
  await test('source-edit-invalidates-old-view-and-exact-reference', async () => {
    const f = fixture(); ok(f.publish()); const old = f.store.snapshot()!, view = await f.open()
    f.repository.transaction(s => { s.episodes[0]!.content = 'I really like tea' })
    assert.equal(f.store.snapshot()!.manifest.state, 'stale')
    denied(await view.resolveClaims([old.semanticBundle.claims[0]!.ref]), 'stale-projection')
    ok(f.publish()); assert.notEqual(f.store.snapshot()!.manifest.manifestId, old.manifest.manifestId)
    denied(await (await f.open()).resolveClaims([old.semanticBundle.claims[0]!.ref]), 'source-unavailable')
  })
  await test('deleted-source-never-served-from-checkpoint', async () => {
    const f = fixture(); ok(f.publish()); const old = f.store.snapshot()!, view = await f.open()
    f.repository.transaction(s => { s.episodes[0]!.contentState = 'deleted'; s.episodes[0]!.deletedAt = 150; delete s.episodes[0]!.content })
    denied(await f.store.evidenceReader.readSources(view, old.semanticBundle.claims[0]!.provenance.sources), 'stale-projection')
    ok(f.publish()); assert.equal(f.store.snapshot()!.semanticBundle.claims.length, 0)
    assert.equal(f.disk()!.includes('I like tea'), false)
  })
  await test('current-policy-denial-invalidates-view', async () => {
    const f = fixture(); ok(f.publish()); const v = await f.open(); f.deny()
    denied(await v.resolveClaims([]), 'stale-projection')
  })
  await test('grant-revocation-and-version-change', async () => {
    for (const action of ['revoke', 'rotate'] as const) {
      const f = fixture(); ok(f.publish()); const v = await f.open(); f[action]()
      denied(await v.resolveClaims([]), 'scope-denied')
    }
  })
  await test('caller-cannot-forge-grant-or-view', async () => {
    const f = fixture(); ok(f.publish()); const req = f.request()
    denied(await f.store.openView({ ...req, access: { ...req.access, accessContextId: 'forged' } }), 'scope-denied')
    const v = await f.open()
    denied(await f.store.evidenceReader.readSources({ ...v }, []), 'view-closed')
    assert.equal(Object.isFrozen(v.context.access), true)
  })
  await test('wrong-claim-version-not-substituted', async () => {
    const f = fixture(); ok(f.publish()); const claim = f.store.snapshot()!.semanticBundle.claims[0]!
    denied(await (await f.open()).resolveClaims([{ ...claim.ref, version: 9 }]), 'source-unavailable')
  })
  await test('time-filter-does-not-change-publication', async () => {
    const f = fixture(); ok(f.publish()); const manifest = f.store.snapshot()!.manifest.manifestId
    const v = ok(await f.store.openView({ ...f.request(), temporal: { knownAt: 200, valid: { kind: 'at', at: 50 } } }))
    denied(await v.resolveClaims([f.store.snapshot()!.semanticBundle.claims[0]!.ref]), 'source-unavailable')
    assert.equal(v.manifest.manifestId, manifest)
  })
  await test('closed-view-blocks-all-evidence', async () => {
    const f = fixture(); ok(f.publish()); const v = await f.open(); await v.close()
    denied(await v.resolveClaims([]), 'view-closed'); assert.equal(await f.store.isViewLive(v.viewId), false)
    denied(await f.store.evidenceReader.readSources(v, []), 'view-closed')
  })
  await test('node-and-evidence-budgets', async () => {
    const f = fixture(); ok(f.publish()); const req = f.request(), c = f.store.snapshot()!.semanticBundle.claims[0]!
    const node = ok(await f.store.openView({ ...req, budget: { ...req.budget, maxNodes: 0 } }))
    denied(await node.resolveClaims([c.ref]), 'budget-exhausted')
    denied(await f.store.evidenceReader.resolveFactVersions(node, [c.fact]), 'budget-exhausted')
    denied(await f.store.evidenceReader.readSources(node, c.provenance.sources), 'budget-exhausted')
    const text = ok(await f.store.openView({ ...req, budget: { ...req.budget, maxEvidenceTokens: 1 } }))
    denied(await f.store.evidenceReader.readSources(text, c.provenance.sources), 'budget-exhausted')
  })
  await test('failed-save-not-acknowledged', () => {
    const f = fixture(); f.options.persistence.save = () => { throw new Error('disk') }
    denied(f.publish(), 'not-ready'); assert.equal(f.store.snapshot(), undefined)
  })
  await test('source-change-during-save-not-acknowledged', () => {
    const f = fixture(); const save = f.options.persistence.save
    f.options.persistence.save = text => { save(text); f.deny() }
    denied(f.publish(), 'stale-projection'); assert.equal(f.store.snapshot(), undefined)
  })
  await test('legacy-checkpoint-requires-republication', () => {
    const f = fixture(); ok(f.publish()); const old = JSON.parse(f.disk()!); delete old.schema; f.setDisk(JSON.stringify(old))
    const reload = createV4L1Store(f.options); assert.equal(reload.snapshot(), undefined)
    ok(reload.publishCurrent({ operationId: 'migrate', expectedManifestId: null, scope }))
    assert.equal(reload.snapshot()!.semanticBundle.claims.length, 1)
  })
  await test('direct-route-stable-manifest-across-time-and-sharing-queries', async () => {
    const f = fixture(); const port = createV4GraphMemory(f.options)
    const request: GraphRecallRequest = { protocolVersion: 'memory-graph/v1', recallId: 'r', query: 'tea', scope,
      mode: 'direct-only', temporal: { knownAt: 200, valid: { kind: 'at', at: 200 } },
      budget: { ...V4_GRAPH_BUDGET }, sharePolicies: ['local-only'], sensitivities: ['normal'] }
    const first = ok(await port.recall(request))
    const second = ok(await port.recall({ ...request, recallId: 'r2', temporal: { knownAt: 200, valid: { kind: 'at', at: 50 } } }))
    const third = ok(await port.recall({ ...request, recallId: 'r3', sharePolicies: ['allow-remote'] }))
    assert.equal(first.manifestId, second.manifestId); assert.equal(first.manifestId, third.manifestId)
    assert.equal(second.evidence.claims.length, 0); assert.equal(third.evidence.claims.length, 0)
  })
  await test('L2-reader-pins-real-L1-view-and-stops-after-close', async () => {
    const f = fixture(); ok(f.publish()); const core = await f.open()
    const repository = createGraphRelationRepository({ coreSnapshot: () => f.store.snapshot()!, now: () => 200,
      verifySources: async () => ({ ok: true, value: undefined }) })
    const relations = createGraphRelationReadPort({ repository, isCoreViewLive: f.store.isViewLive,
      verifySources: async () => ({ ok: true, value: undefined }) })
    const l2 = ok(await relations.openView({ coreView: core, expectedRelationManifestId: repository.snapshot().manifest.manifestId }))
    ok(await l2.resolveRelations([])); assert.equal(l2.coreViewId, core.viewId)
    await core.close(); denied(await l2.resolveRelations([]), 'view-closed')
  })
  return { kind: 'fixed-L1-publication-and-view-regression', checks }
}
