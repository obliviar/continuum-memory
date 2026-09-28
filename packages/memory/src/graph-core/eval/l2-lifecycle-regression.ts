import assert from 'node:assert/strict'
import type { GraphResult } from '@continuum-memory/contracts'
import { createL2HostFixture } from './l2-host-regression'
import { createV4L2Memory } from '../adapters/v4-l2-memory'
import { reconcileV4RelationLifecycle } from '../adapters/v4-relation-lifecycle'
import { v4FactIdFromClaim } from '../adapters/v4-semantic-adapter'
import type { GraphRelationSnapshot } from '../domain/relation-types'
import { createMemoryV4LifecycleService } from '../../v4/lifecycle/memory-v4-lifecycle'
import { createMemoryV4Repository, parseMemoryV4Snapshot } from '../../v4/repository/memory-v4-repository'
import { V4_TEST_SCOPE as scope } from '../fixtures/v4-direct-memory'

type Wrapper = <T extends { save: (payload: string) => void }>(persistence: T, before: (payload: string) => void) => T
function ok<T>(r: GraphResult<T>): T { if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`); return r.value }

/** Uses the real desktop persistence wrapper, supplied by the single-process runner. */
export async function runL2LifecycleRegression(wrap: Wrapper) {
  const checks: { id: string; passed: boolean; error?: string }[] = []
  async function test(id: string, run: () => Promise<void>) {
    try { await run(); checks.push({ id, passed: true }) }
    catch (error) { checks.push({ id, passed: false, error: String(error) }) }
  }
  async function fixture() {
    const f = createL2HostFixture()
    f.repository.transaction(s => {
      s.episodes.push({ ...s.episodes[0]!, id: 'ep-other', content: '按下开关导致灯亮。' })
      for (const [i, text] of ['按下开关', '灯亮'].entries()) {
        const id = i === 0 ? 'f:other' : 'f:other:next', ev = `other-ev-${i}`
        s.evidenceLinks.push({ ...s.evidenceLinks[0]!, id: ev, factId: id, episodeId: 'ep-other' })
        s.facts.push({ ...s.facts[0]!, id, canonicalText: text, object: text, normalizedValue: text, evidenceLinkIds: [ev] })
        s.factVersions.push({ ...s.factVersions[0]!, id: `other-version-${i}`, factId: id,
          canonicalText: text, object: text, normalizedValue: text, evidenceLinkIds: [ev] })
      }
    })
    const prepared = await f.publish(), base = prepared.repository.snapshot()
    const [a, b] = prepared.core.l1.snapshot()!.semanticBundle.claims.filter(c => c.fact.id.startsWith('f:other'))
    const cause = base.relations[0]!
    ok(await prepared.repository.publish({ operationId: 'with-candidates-and-unrelated', expectedManifestId: base.manifest.manifestId,
      snapshot: { ...base, manifest: { ...base.manifest, manifestId: 'lifecycle-fixture', relationRevision: 2, candidateRevision: 1 },
        relations: [...base.relations, { ...cause, ref: { kind: 'relation', id: 'unrelated', version: 1 },
          from: a!.ref, to: b!.ref, context: a!.context, provenance: a!.provenance,
          evidence: [{ source: a!.provenance.sources[0]!, role: 'supports' }] }],
        candidates: [{ id: 'candidate', scope, from: cause.from, to: cause.to, context: cause.context,
          kind: cause.kind, validTime: cause.validTime, sourceHints: cause.provenance.sources,
          hypothesisText: '下雨导致比赛取消', generator: { route: 'human', version: 'test' },
          resolution: { status: 'accepted', relation: cause.ref } }],
        observations: [{ id: 'observation', candidateId: 'candidate', premise: { kind: 'claim', ref: cause.from },
          premiseHash: 'test-premise', hypothesisHash: 'test-hypothesis', scores: { ENTAILMENT: 0.8, NEUTRAL: 0.1, CONTRADICTION: 0.1 },
          predicted: 'ENTAILMENT', modelId: 'synthetic', modelRevision: '1', preprocessingVersion: '1', truncated: false, evaluatedAt: 100 }] } }))
    let v4Payload = JSON.stringify(f.repository.snapshot()), failSource = false, failRelation = false
    const order: string[] = []
    const persistence = { ...f.options.relationPersistence, save: (payload: string) => {
      order.push('L2'); if (failRelation) throw new Error('L2 disk failed'); f.options.relationPersistence.save(payload)
    } }
    const repository = createMemoryV4Repository({ now: () => 200, persistence: wrap({ load: () => v4Payload,
      save: (payload: string) => { order.push('V4'); if (failSource) throw new Error('V4 disk failed'); v4Payload = payload } }, payload => {
      f.options.persistence.save('{}')
      reconcileV4RelationLifecycle(persistence, parseMemoryV4Snapshot(payload), { now: () => 200 })
    }) })
    return { f, repository, persistence, order, lifecycle: createMemoryV4LifecycleService(repository, { now: () => 200 }),
      read: () => JSON.parse(persistence.load()!) as GraphRelationSnapshot,
      failSource: () => { failSource = true }, failRelation: () => { failRelation = true } }
  }
  const deletion = { reason: 'synthetic lifecycle regression', idempotencyKey: 'delete-test' }
  function assertPruned(s: GraphRelationSnapshot) {
    assert.deepEqual(s.relations.map(r => r.ref.id), ['unrelated'])
    assert.deepEqual(s.candidates, []); assert.deepEqual(s.observations, [])
    assert.equal(s.manifest.state, 'stale')
    assert.equal(s.manifest.relationRevision, 3); assert.equal(s.manifest.candidateRevision, 2)
  }
  await test('delete-shared-source-fact-prunes-only-related-L2-before-V4', async () => {
    const f = await fixture(); f.lifecycle.deleteFact('f', scope, 'delete', deletion)
    assertPruned(f.read()); assert.deepEqual(f.order, ['L2', 'V4'])
    assert.equal(f.repository.snapshot().episodes[0]!.contentState, 'available')
  })
  await test('privacy-purge-also-removes-candidate-text-and-NLI', async () => {
    const f = await fixture(); f.lifecycle.deleteFact('f', scope, 'purge', deletion)
    assertPruned(f.read()); assert.equal(f.persistence.load()!.includes('下雨导致比赛取消'), false)
    assert.equal(f.repository.snapshot().facts[0]!.canonicalText, '[purged]')
  })
  await test('deleted-episode-cascades-through-evidence', async () => {
    const f = await fixture(); f.repository.transaction(s => {
      s.episodes[0]!.contentState = 'deleted'; s.episodes[0]!.deletedAt = 200; delete s.episodes[0]!.content
    }); assertPruned(f.read())
  })
  await test('ordinary-source-update-preserves-records-but-revokes-view', async () => {
    const f = await fixture(), before = f.read()
    f.repository.transaction(s => { s.episodes[0]!.content += '补充。' })
    assert.deepEqual(f.read().relations, before.relations); assert.deepEqual(f.read().candidates, before.candidates)
    assert.equal(f.read().manifest.state, 'stale'); assert.equal(f.read().manifest.relationRevision, 2)
  })
  await test('suppression-is-not-irreversible-relation-purge', async () => {
    const f = await fixture(); f.lifecycle.deleteFact('f', scope, 'suppress', deletion)
    assert.equal(f.read().relations.length, 3); assert.equal(f.read().manifest.state, 'stale')
  })
  await test('startup-cleans-legacy-deletion-without-L1-checkpoint', async () => {
    const f = await fixture()
    createMemoryV4LifecycleService(f.f.repository, { now: () => 200 }).deleteFact('f', scope, 'delete', deletion)
    const v4 = f.f.repository.snapshot(); f.f.options.persistence.save('{}')
    const report = reconcileV4RelationLifecycle(f.persistence, v4, { invalidate: false, now: () => 200 })
    assert.equal(report.removedRelations, 2); assertPruned(f.read())
    const saved = f.persistence.load()
    assert.equal(reconcileV4RelationLifecycle(f.persistence, v4, { invalidate: false }).changed, false)
    assert.equal(f.persistence.load(), saved)
  })
  await test('startup-with-no-deletions-does-not-rewrite-ready-snapshot', async () => {
    const f = await fixture(), saved = f.persistence.load()
    assert.equal(reconcileV4RelationLifecycle(f.persistence, f.repository.snapshot(), { invalidate: false }).changed, false)
    assert.equal(f.persistence.load(), saved)
  })
  await test('L2-write-failure-blocks-V4-deletion', async () => {
    const f = await fixture(), before = f.repository.snapshot(), saved = f.persistence.load(); f.failRelation()
    assert.throws(() => f.lifecycle.deleteFact('f', scope, 'delete', deletion), /L2 disk failed/)
    assert.deepEqual(f.repository.snapshot(), before); assert.equal(f.persistence.load(), saved)
    assert.deepEqual(f.order, ['L2'])
  })
  await test('V4-write-failure-does-not-resurrect-pruned-relations', async () => {
    const f = await fixture(), before = f.repository.snapshot(); f.failSource()
    assert.throws(() => f.lifecycle.deleteFact('f', scope, 'delete', deletion), /V4 disk failed/)
    assert.deepEqual(f.repository.snapshot(), before); assertPruned(f.read())
  })
  await test('restart-does-not-recall-purged-L2', async () => {
    const f = await fixture(); f.lifecycle.deleteFact('f', scope, 'delete', deletion)
    const port = createV4L2Memory({ ...f.f.options, repository: f.repository })
    const result = await port.recall(f.f.request())
    assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, 'stale-projection')
    assertPruned(f.read())
  })
  await test('colon-containing-fact-IDs-do-not-delete-prefix-neighbors', async () => {
    const f = await fixture()
    const target = f.read().relations.find(r => r.ref.id === 'unrelated')!
    assert.equal(v4FactIdFromClaim(target.from), 'f:other')
    assert.equal(v4FactIdFromClaim(target.to), 'f:other:next')
    f.lifecycle.deleteFact('f:other', scope, 'delete', deletion)
    assert.deepEqual(f.read().relations.map(r => r.ref.id), ['causes', 'precedes'])
    assert.equal(f.repository.snapshot().facts.find(r => r.id === 'f:other:next')!.status, 'active')
  })
  await test('malformed-V4-input-cannot-trigger-broad-cleanup', async () => {
    const f = await fixture(), saved = f.persistence.load(), bad = f.repository.snapshot()
    Reflect.set(bad, 'schemaVersion', -1)
    assert.throws(() => reconcileV4RelationLifecycle(f.persistence, bad))
    assert.equal(f.persistence.load(), saved)
  })
  return { kind: 'real-desktop-write-hook-with-synthetic-V4-L2-records', checks }
}
