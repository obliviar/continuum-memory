import assert from 'node:assert/strict'
import type { GraphRecallRequest, GraphRecallResult, GraphResult } from '@continuum-memory/contracts'
import type { GraphClaimRecord } from '../domain/types'
import { createMemoryV4Repository } from '../../v4/repository/memory-v4-repository'
import { createGraphExtractionRun } from '../../long-term/graph-extraction-result'
import { createGraphPredicateRegistry, normalizeGraphExtraction } from '../../long-term/graph-identity-normalization'
import { assessGraphClaim, confirmGraphClaim, createGraphL1Store, createGraphL1Writer } from '../../long-term/graph-l1-write'
import { createGraphSemanticRepository } from '../repository/semantic-repository'
import { createGraphL1ProjectionRepository } from '../repository/l1-projection-repository'
import { createGraphRelationRepository } from '../repository/relation-repository'
import { stageGraphRelationTasks } from '../repository/relation-task-staging'
import { publishReviewedGraphRelation } from '../repository/relation-admission'
import { graphRelationPairKey, type GraphRelationJudgementTask } from '../repository/relation-task-queue'
import { rebaseGraphRelations } from '../repository/relation-rebase'
import { createV4L2Memory, V4_L2_BUDGET, type V4L2MemoryOptions } from '../adapters/v4-l2-memory'
import { selectRetrievableGraphBundle } from '../adapters/v4-graph-memory'
import { createV4RelationSourceReader } from '../adapters/v4-relation-sources'
import { V4_SCALAR_MAPPING_POLICY, sourceHash } from '../adapters/v4-semantic-adapter'

const scope = { ownerId: 'owner', agentId: 'agent' }, at = 1_800_000_000_000
const memory = () => { let data: string | undefined; return { load: () => data, save: (s: string) => { data = s } } }
const value = <T>(r: GraphResult<T>): T => { if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`); return r.value }
async function fixture(label: 'ENTAILMENT' | 'CONTRADICTION' = 'ENTAILMENT') {
  const repository = createMemoryV4Repository({ now: () => at }), store = createGraphL1Store(memory())
  const semantic = createGraphSemanticRepository(memory(), repository), registry = createGraphPredicateRegistry()
  const projection = createGraphL1ProjectionRepository(memory(), semantic, repository, store)
  const sync = async () => { value(await semantic.syncFromClaims(store, repository, registry, scope)); assert(projection.sync()) }
  const writer = createGraphL1Writer(repository, store, registry, scope, { syncFromClaims: sync })
  const entities = [
    { ref: { kind: 'entity' as const, id: 'alex', version: 1 }, scope, entityType: 'person', canonicalName: 'Alexander', aliases: ['Alex', 'AliasOnly'] },
    { ref: { kind: 'entity' as const, id: 'acme', version: 1 }, scope, entityType: 'organization', canonicalName: 'Acme', aliases: [] },
  ]
  for (const [i, name] of ['Alex', 'Alexander'].entries()) {
    const sourceText = `${name} works at Acme`
    const run = createGraphExtractionRun({ sourceId: `synthetic-${i}`, sourceText, modelId: 'synthetic-fixture', rawOutput: { graph: {
      entities: [{ id: 'p', type: 'person', text: name, span: { start: 0, end: name.length }, modelScore: 0.9 },
        { id: 'o', type: 'organization', text: 'Acme', span: { start: sourceText.length - 4, end: sourceText.length }, modelScore: 0.9 }],
      facts: [{ id: 'f', subjectMentionId: 'p', predicate: 'works at', object: { mentionId: 'o' },
        evidenceSpan: { start: 0, end: sourceText.length }, modelScore: 0.9,
        context: { negation: { value: false, resolution: 'resolved' }, condition: { value: null, resolution: 'absent' },
          time: { value: '2026-09-26', resolution: 'resolved' }, speaker: { value: null, resolution: 'absent' } } }] } } })
    const fact = normalizeGraphExtraction(run, { scope, entities, contextEntityIds: ['alex', 'acme'] }).facts[0]!
    const review = confirmGraphClaim(assessGraphClaim(run, fact, { sensitivity: 'normal', sharePolicy: 'allow-remote' }, at),
      'Synthetic fixture approval, not an actual user decision', at)
    assert.equal((await writer.submit(run, fact, review, entities))?.state, 'published')
  }
  let retain = true, readable = true, available = true, legacyReads = 0
  const access = { accessContextId: 'fixture', authorizationVersion: '1', scope,
    sharePolicies: ['allow-remote' as const], sensitivities: ['normal' as const] }
  const options: V4L2MemoryOptions = { repository, persistence: memory(),
    relationPersistence: { load: () => { legacyReads++; return 'legacy-file-must-not-be-read' }, save: () => { throw new Error('Legacy write forbidden') } },
    now: () => at + 100, countTokens: s => Buffer.byteLength(s), includeOwnedSessions: true,
    authorizeScope: s => s.ownerId === scope.ownerId && s.agentId === scope.agentId && s.sessionId === undefined,
    canRead: () => readable, resolveGraphAccess: () => access,
    acceptedBundle: () => selectRetrievableGraphBundle(projection.snapshot()?.semanticBundle,
      store.tasks().map(t => ({ ...t, review: { ...t.review, retrieval: { ...t.review.retrieval, retain } } }))) }
  const nativePersistence = memory()
  const makeRelations = () => createGraphRelationRepository({ coreSnapshot: () => projection.snapshot()!,
    persistence: nativePersistence, now: () => at + 50, verifySources: createV4RelationSourceReader(options).verify })
  let relations = makeRelations()
  options.nativeRelations = { projection: () => projection.snapshot(), repository: () => available ? relations : undefined }
  const port = createV4L2Memory(options), core = projection.snapshot()!, [from, to] = core.semanticBundle.claims
  assert.equal(core.semanticBundle.claims.length, 2)
  const evidenceText = (c: GraphClaimRecord) => c.provenance.sources.map(s => {
    const text = repository.snapshot().episodes.find(e => e.id === s.episodeId)!.content!
    return s.locator.kind === 'text-span' ? text.slice(s.locator.start, s.locator.end) : text
  }).join('\n')
  const task: GraphRelationJudgementTask = { key: graphRelationPairKey(from!.ref, to!.ref, 'synthetic-nli', '1', '1'),
    claims: [from!.ref, to!.ref], modelId: 'synthetic-nli', modelRevision: '1', preprocessingVersion: '1',
    routes: ['structured'], status: 'completed', createdAt: at, result: { label,
      scores: label === 'ENTAILMENT' ? { ENTAILMENT: 0.9, NEUTRAL: 0.05, CONTRADICTION: 0.05 }
        : { ENTAILMENT: 0.05, NEUTRAL: 0.05, CONTRADICTION: 0.9 },
      premiseHash: sourceHash(evidenceText(from!)), hypothesisHash: sourceHash(evidenceText(to!)), truncated: false, evaluatedAt: at + 1 } }
  value(await stageGraphRelationTasks({ repository: relations, core, tasks: [task], evidenceText, now: () => at + 2 }))
  const publish = () => publishReviewedGraphRelation({ repository: relations, core: projection.snapshot()!,
    candidateId: relations.snapshot().candidates[0]!.id, reason: 'Synthetic explicit relation approval',
    reviewer: 'synthetic-test-reviewer', evidenceText, now: () => at + 3 })
  const request: GraphRecallRequest = { protocolVersion: 'memory-graph/v1', recallId: 'native-test', query: 'Acme相关的记忆', scope,
    mode: 'direct-only', temporal: { knownAt: at + 100, valid: { kind: 'at', at: Date.UTC(2026, 8, 26, 12) } },
    sharePolicies: ['allow-remote'], sensitivities: ['normal'], budget: { ...V4_L2_BUDGET } }
  return { repository, store, projection, sync, port, options, request, publish, nativePersistence, access,
    relations: () => relations, withdraw: () => { retain = false }, deny: () => { readable = false },
    unavailable: () => { available = false }, reload: () => { relations = makeRelations() }, legacyReads: () => legacyReads }
}

export { fixture as createNativeL2Fixture }

export async function runNativeL2Regression(validatePrompt: (result: GraphRecallResult) => string) {
  const checks: { id: string; passed: boolean; error?: string }[] = []
  async function test(id: string, run: () => Promise<void>) { try { await run(); checks.push({ id, passed: true }) }
    catch (e) { checks.push({ id, passed: false, error: String(e) }) } }
  await test('pending-nli-is-not-answer-relation', async () => {
    const f = await fixture(), before = f.nativePersistence.load()
    const r = value(await f.port.recall(f.request)); assert.equal(r.evidence.relations?.length, 0)
    assert.equal(f.nativePersistence.load(), before); assert.equal(f.legacyReads(), 0)
  })
  await test('explicit-native-admission-reaches-chat-with-original-manifests', async () => {
    const f = await fixture(); value(await f.publish()); const before = f.nativePersistence.load()
    const r = value(await f.port.recall(f.request)), relation = f.relations().snapshot().relations[0]!
    assert.equal(r.manifestId, f.projection.snapshot()!.manifest.manifestId)
    assert.equal(r.evidence.relationManifestId, f.relations().snapshot().manifest.manifestId)
    assert.equal(r.evidence.relations?.length, 1); assert.equal(r.evidence.claims.length, 2)
    assert.deepEqual(r.evidence.relations![0]!.from, relation.from); assert.deepEqual(r.evidence.relations![0]!.to, relation.to)
    assert.ok(r.trace.searchScope.includes('native-reviewed-L2')); assert.equal(r.trace.completeness, 'incomplete')
    assert.equal(r.evidence.proofs.length, 0); assert.ok(validatePrompt(r).includes('R1'))
    assert.equal(f.nativePersistence.load(), before); assert.equal(f.legacyReads(), 0)
  })
  await test('native-desktop-path-needs-no-second-l2-persistence', async () => {
    const f = await fixture(); value(await f.publish())
    const port = createV4L2Memory({ ...f.options, relationPersistence: undefined })
    const result = value(await port.recall(f.request))
    assert.equal(result.evidence.relations?.length, 1)
    assert.equal(f.legacyReads(), 0)
  })
  await test('entity-alias-finds-native-relation-endpoint', async () => {
    const f = await fixture(); value(await f.publish())
    for (const alias of ['AliasOnly', 'aliasonly', 'ＡｌｉａｓＯｎｌｙ'])
      assert.equal(value(await f.port.recall({ ...f.request, query: `${alias}相关的记忆` })).evidence.relations?.length, 1)
    assert.equal(value(await f.port.recall({ ...f.request, query: 'AliasOn相关的记忆' })).evidence.relations?.length, 0)
  })
  await test('entailment-is-not-causal-evidence', async () => {
    const f = await fixture(); value(await f.publish())
    assert.equal(value(await f.port.recall({ ...f.request, query: '为什么Alex works at Acme' })).evidence.relations?.length, 0)
  })
  await test('native-recall-survives-repository-reload', async () => {
    const f = await fixture(); value(await f.publish()); f.reload()
    assert.equal(value(await createV4L2Memory(f.options).recall(f.request)).evidence.relations?.length, 1)
  })
  await test('native-contradiction-keeps-type-and-is-not-a-proof', async () => {
    // Deliberately synthetic NLI observation: this checks transport, not classifier accuracy.
    const f = await fixture('CONTRADICTION'); value(await f.publish())
    const result = value(await f.port.recall(f.request))
    assert.equal(result.evidence.relations?.[0]?.kind, 'contradicts')
    assert.equal(result.evidence.proofs.length, 0); assert.equal(result.trace.completeness, 'incomplete')
  })
  await test('missing-native-authority-never-falls-back-to-legacy', async () => {
    const f = await fixture(); value(await f.publish()); f.unavailable()
    assert.equal((await f.port.recall(f.request)).ok, false); assert.equal(f.legacyReads(), 0)
  })
  await test('wrong-manifest-and-cross-owner-denied', async () => {
    const f = await fixture(); value(await f.publish())
    assert.equal((await f.port.recall({ ...f.request, expectedManifestId: 'combined-or-old' })).ok, false)
    assert.equal((await f.port.recall({ ...f.request, scope: { ...scope, ownerId: 'other' } })).ok, false)
  })
  await test('withdrawal-removes-seeds-and-review-labels', async () => {
    const f = await fixture(); value(await f.publish()); f.withdraw()
    assert.equal(value(await f.port.recall(f.request)).evidence.relations?.length, 0)
    const review = value(await f.port.reviewRelations(scope)); assert.equal(review.canPublish, false)
    assert.ok(review.relations.every(r => r.fromText === null && r.toText === null))
  })
  await test('permission-denial-does-not-feed-vector-seeds', async () => {
    const f = await fixture(); value(await f.publish()); f.deny(); let embedded = false
    const port = createV4L2Memory({ ...f.options, semantic: { model: 'test', dimensions: 2,
      index: { get: () => [1, 0] }, embedQuery: async () => { embedded = true; return { model: 'test', vector: [1, 0] } } } })
    assert.equal(value(await port.recall(f.request)).evidence.relations?.length, 0); assert.equal(embedded, false)
  })
  await test('source-deletion-and-source-edit-revoke-native-evidence', async () => {
    for (const deleted of [true, false]) {
      const f = await fixture(); value(await f.publish())
      f.repository.transaction(s => { if (deleted) { s.episodes[0]!.contentState = 'deleted'; s.episodes[0]!.deletedAt = at; delete s.episodes[0]!.content }
        else s.episodes[0]!.content = 'changed' })
      assert.equal((await f.port.recall(f.request)).ok, false)
    }
  })
  await test('native-view-closing-and-source-invalidation', async () => {
    const f = await fixture(); value(await f.publish()); const prepared = value(f.port.prepareRelations(scope)), l1 = prepared.core.l1
    const view = value(await l1.openView({ access: f.access, temporal: f.request.temporal, budget: f.request.budget,
      expectedManifestId: f.projection.snapshot()!.manifest.manifestId, policyVersion: V4_SCALAR_MAPPING_POLICY }))
    const claim = f.store.claims()[0]!
    assert.equal(value(await l1.evidenceReader.readSources(view, claim.provenance.sources)).length, 1)
    f.withdraw(); assert.equal((await view.resolveClaims([claim.ref])).ok, false)
    await view.close(); assert.equal(await l1.isViewLive(view.viewId), false)
    assert.equal((await l1.evidenceReader.readSources({ ...view }, claim.provenance.sources)).ok, false)
  })
  await test('read-budget-exhaustion-returns-no-partial-proof', async () => {
    const f = await fixture(); value(await f.publish())
    assert.equal((await f.port.recall({ ...f.request, budget: { ...f.request.budget, maxEvidenceTokens: 1 } })).ok, false)
  })
  await test('native-review-republishes-same-authority-not-legacy', async () => {
    const f = await fixture(); value(await f.publish()); const review = value(await f.port.reviewRelations(scope)); assert.ok(review.reviewId)
    value(await f.port.republishRelations({ reviewId: review.reviewId, scope, operationId: 'native-review', reviewer: 'fixture', reason: 'Checked current versions' }))
    assert.equal(f.relations().snapshot().lastRevalidation?.operationId, 'native-review')
    assert.equal(f.legacyReads(), 0); assert.equal(value(await f.port.recall(f.request)).evidence.relations?.length, 1)
  })
  await test('native-publication-change-during-vector-await-is-rejected', async () => {
    const f = await fixture(); value(await f.publish())
    const port = createV4L2Memory({ ...f.options, semantic: { model: 'test', dimensions: 2, index: { get: () => [1, 0] },
      embedQuery: async () => { f.reload(); return { model: 'test', vector: [1, 0] } } } })
    assert.equal((await port.recall(f.request)).ok, false)
  })
  await test('native-invalidation-during-vector-await-is-rejected', async () => {
    const f = await fixture(); value(await f.publish())
    const port = createV4L2Memory({ ...f.options, semantic: { model: 'test', dimensions: 2, index: { get: () => [1, 0] },
      embedQuery: async () => {
        value(await f.relations().invalidate({ operationId: 'revoke', scope,
          expectedManifestId: f.relations().snapshot().manifest.manifestId,
          nextManifestId: 'revoked-during-query', reason: 'authorization-changed' }))
        return { model: 'test', vector: [1, 0] }
      } } })
    assert.equal((await port.recall(f.request)).ok, false)
  })
  await test('repository-reload-revokes-an-outstanding-review-token', async () => {
    const f = await fixture(); value(await f.publish()); const review = value(await f.port.reviewRelations(scope))
    assert.ok(review.reviewId); f.reload()
    assert.equal((await f.port.republishRelations({ reviewId: review.reviewId, scope,
      operationId: 'old-preview', reviewer: 'fixture', reason: 'Old preview must expire' })).ok, false)
  })
  await test('session-source-reader-requires-explicit-owner-access', async () => {
    const f = await fixture(), original = f.store.claims()[0]!.provenance.sources[0]!
    const refs = [{ ...original, episodeId: 'session-reader-fixture' }]
    // Independent source avoids changing the scope of an existing, linked V4 fact.
    f.repository.transaction(s => { s.episodes.push({ ...structuredClone(s.episodes.find(e => e.id === original.episodeId)!),
      id: refs[0]!.episodeId, scope: { ...scope, sessionId: 'capture-session' } }) })
    const reader = createV4RelationSourceReader(f.options)
    assert.equal(reader.read(refs, f.access).ok, true)
    assert.equal(createV4RelationSourceReader({ ...f.options, includeOwnedSessions: false }).read(refs, f.access).ok, false)
    const scopedReader = createV4RelationSourceReader({ ...f.options,
      authorizeScope: s => s.ownerId === scope.ownerId && s.agentId === scope.agentId })
    assert.equal(scopedReader.read(refs, { ...f.access, scope: { ...scope, sessionId: 'another-session' } }).ok, false)
    f.repository.transaction(s => { s.episodes.find(e => e.id === refs[0]!.episodeId)!.scope.ownerId = 'someone-else' })
    assert.equal(reader.read(refs, f.access).ok, false)
  })
  await test('v4-revision-needs-explicit-host-sync-before-native-read', async () => {
    const f = await fixture(); value(await f.publish())
    f.repository.transaction(s => { s.facts[0]!.accessCount++ })
    assert.equal((await f.port.recall(f.request)).ok, false)
    await f.sync(); value(await rebaseGraphRelations({ repository: f.relations(), core: f.projection.snapshot()!, now: () => at + 50 }))
    assert.equal(value(await f.port.recall(f.request)).evidence.relations?.length, 1)
  })
  return { tests: checks.length, passed: checks.filter(c => c.passed).length, checks }
}
