import assert from 'node:assert/strict'
import type { GraphResult } from '@continuum-memory/contracts'
import { createL2HostFixture } from './l2-host-regression'
import { V4_TEST_SCOPE as scope } from '../fixtures/v4-direct-memory'
import { createV4L2Memory, invalidateV4RelationCheckpoint } from '../adapters/v4-l2-memory'

function ok<T>(r: GraphResult<T>): T { if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`); return r.value }
function failed(r: GraphResult<unknown>, code?: string) { assert.equal(r.ok, false); if (!r.ok && code) assert.equal(r.error.code, code) }
const confirmation = (reviewId: string) => ({ reviewId, scope, operationId: 'explicit-review', reviewer: 'test-human', reason: 'Checked unchanged endpoints and sources' })

export async function runL2ReviewRegression() {
  const checks: { id: string; passed: boolean; error?: string }[] = []
  async function test(id: string, action: () => Promise<void>) {
    try { await action(); checks.push({ id, passed: true }) }
    catch (error) { checks.push({ id, passed: false, error: String(error) }) }
  }
  async function fixture() {
    const f = createL2HostFixture(); await f.publish()
    const before = JSON.parse(f.options.relationPersistence.load()!)
    f.repository.transaction(s => { s.facts[0]!.accessCount++ })
    return { ...f, before }
  }
  await test('preview-only-prepares-report-and-does-not-enable-L2', async () => {
    const f = await fixture(), r = ok(await f.port.reviewRelations(scope))
    assert.equal(r.canPublish, true); assert.ok(r.reviewId)
    assert.equal(r.relations[0]!.fromText, '下雨'); assert.equal(r.relations[0]!.toText, '比赛取消')
    assert.equal(JSON.parse(f.options.relationPersistence.load()!).manifest.state, 'stale')
    failed(await f.port.recall(f.request()), 'stale-projection')
  })
  await test('confirmed-revalidation-restores-recall-with-identical-relations', async () => {
    const f = await fixture(), r = ok(await f.port.reviewRelations(scope))
    ok(await f.port.republishRelations(confirmation(r.reviewId!)))
    const saved = JSON.parse(f.options.relationPersistence.load()!)
    assert.deepEqual(saved.relations, f.before.relations)
    assert.equal(saved.manifest.relationRevision, f.before.manifest.relationRevision)
    assert.equal(saved.manifest.candidateRevision, f.before.manifest.candidateRevision)
    assert.equal(saved.lastRevalidation.reviewer, 'test-human')
    assert.equal(saved.lastRevalidation.previousCoreManifestId, f.before.manifest.coreManifestId)
    assert.equal(saved.lastRevalidation.targetCoreManifestId, r.targetCoreManifestId)
    assert.equal(ok(await f.port.recall(f.request())).evidence.relations!.length, 1)
    assert.equal(ok(await createV4L2Memory(f.options).recall(f.request())).evidence.relations!.length, 1)
  })
  await test('changed-source-blocks-review-without-rebinding-endpoints', async () => {
    const f = await fixture(); f.repository.transaction(s => { s.episodes[0]!.content += '变化。' })
    const r = ok(await f.port.reviewRelations(scope))
    assert.equal(r.canPublish, false); assert.equal(r.reviewId, null)
    assert.ok(r.relations[0]!.reasons.includes('exact-endpoint-unavailable'))
    assert.equal(r.relations[0]!.fromText, null)
    assert.deepEqual(JSON.parse(f.options.relationPersistence.load()!).relations, f.before.relations)
  })
  await test('source-change-after-preview-invalidates-confirmation', async () => {
    const f = await fixture(), r = ok(await f.port.reviewRelations(scope))
    f.repository.transaction(s => { s.episodes[0]!.content += '再次变化。' })
    failed(await f.port.republishRelations(confirmation(r.reviewId!)), 'version-mismatch')
    assert.equal(JSON.parse(f.options.relationPersistence.load()!).manifest.state, 'stale')
  })
  await test('concurrent-L2-change-invalidates-confirmation', async () => {
    const f = await fixture(), r = ok(await f.port.reviewRelations(scope))
    const p = ok(f.port.prepareRelations(scope)), s = p.repository.snapshot()
    ok(await p.repository.invalidate({ operationId: 'competing-write', scope, expectedManifestId: s.manifest.manifestId,
      nextManifestId: 'competing-write', reason: 'policy-changed' }))
    failed(await f.port.republishRelations(confirmation(r.reviewId!)), 'version-mismatch')
  })
  await test('returned-report-mutation-cannot-change-published-relations', async () => {
    const f = await fixture(), r = ok(await f.port.reviewRelations(scope))
    Reflect.set(r.relations[0]!.from, 'id', 'forged')
    ok(await f.port.republishRelations(confirmation(r.reviewId!)))
    assert.deepEqual(JSON.parse(f.options.relationPersistence.load()!).relations, f.before.relations)
  })
  await test('review-token-is-single-use', async () => {
    const f = await fixture(), r = ok(await f.port.reviewRelations(scope))
    const results = await Promise.all([f.port.republishRelations(confirmation(r.reviewId!)), f.port.republishRelations(confirmation(r.reviewId!))])
    assert.equal(results.filter(v => v.ok).length, 1)
    failed(results.find(v => !v.ok)!, 'invalid-request')
  })
  await test('unknown-and-expired-review-tokens-cannot-publish', async () => {
    const f = await fixture(); let clock = 200
    const port = createV4L2Memory({ ...f.options, now: () => clock })
    failed(await port.republishRelations(confirmation('unknown')), 'invalid-request')
    const r = ok(await port.reviewRelations(scope)); clock += 300_001
    failed(await port.republishRelations(confirmation(r.reviewId!)), 'invalid-request')
  })
  await test('scope-isolation-applies-to-report-and-confirmation', async () => {
    const f = await fixture(), r = ok(await f.port.reviewRelations(scope))
    failed(await f.port.reviewRelations({ ...scope, ownerId: 'other' }), 'scope-denied')
    failed(await f.port.republishRelations({ ...confirmation(r.reviewId!), scope: { ...scope, sessionId: 'other' } }), 'scope-denied')
  })
  await test('publication-rechecks-revoked-access', async () => {
    const f = await fixture(), r = ok(await f.port.reviewRelations(scope)); f.deny()
    failed(await f.port.republishRelations(confirmation(r.reviewId!)), 'version-mismatch')
  })
  await test('explicit-reviewer-and-reason-required', async () => {
    const f = await fixture(), r = ok(await f.port.reviewRelations(scope))
    failed(await f.port.republishRelations({ ...confirmation(r.reviewId!), reviewer: '' }), 'invalid-request')
    failed(await f.port.republishRelations({ ...confirmation(r.reviewId!), reason: '' }), 'invalid-request')
    assert.equal(JSON.parse(f.options.relationPersistence.load()!).manifest.state, 'stale')
  })
  await test('pending-candidate-stays-pending-after-revalidation', async () => {
    const f = createL2HostFixture(), p = ok(f.port.prepareRelations(scope)), s = p.repository.snapshot()
    const [from, to] = p.core.l1.snapshot()!.semanticBundle.claims
    ok(await p.repository.publish({ operationId: 'pending', expectedManifestId: s.manifest.manifestId,
      snapshot: { ...s, manifest: { ...s.manifest, manifestId: 'pending', candidateRevision: 1 }, candidates: [{
        id: 'pending', scope, from: from!.ref, to: to!.ref, context: from!.context, kind: 'causes', validTime: from!.validTime,
        sourceHints: from!.provenance.sources, hypothesisText: '下雨导致比赛取消', generator: { route: 'dense', version: 'test' }, resolution: { status: 'pending' },
      }] } }))
    invalidateV4RelationCheckpoint(f.options.relationPersistence)
    const r = ok(await f.port.reviewRelations(scope)); assert.equal(r.candidateCount, 1)
    ok(await f.port.republishRelations(confirmation(r.reviewId!)))
    const saved = JSON.parse(f.options.relationPersistence.load()!)
    assert.equal(saved.candidates[0].resolution.status, 'pending'); assert.deepEqual(saved.relations, [])
  })
  await test('failed-save-keeps-stale-state-and-consumes-review-token', async () => {
    const f = await fixture(); let failSave = false
    const port = createV4L2Memory({ ...f.options, relationPersistence: { load: f.options.relationPersistence.load,
      save: payload => { if (failSave) throw new Error('disk'); f.options.relationPersistence.save(payload) } } })
    const r = ok(await port.reviewRelations(scope)), saved = f.options.relationPersistence.load(); failSave = true
    failed(await port.republishRelations(confirmation(r.reviewId!)), 'not-ready')
    assert.equal(f.options.relationPersistence.load(), saved)
    failed(await port.republishRelations(confirmation(r.reviewId!)), 'invalid-request')
  })
  return { kind: 'explicit-host-revalidation-with-synthetic-records', checks }
}
