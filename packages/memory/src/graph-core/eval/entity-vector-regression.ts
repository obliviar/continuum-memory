import assert from 'node:assert/strict'
import type { GraphResult } from '@continuum-memory/contracts'
import { createAcceptedL1Fixture } from './accepted-l1-regression'
import { createNativeL2Fixture } from './native-l2-regression'
import { createL2HostFixture } from './l2-host-regression'
import { createV4GraphMemory, V4_GRAPH_BUDGET } from '../adapters/v4-graph-memory'
import { createV4L2Memory } from '../adapters/v4-l2-memory'
import { createMemoryEmbeddingIndex } from '../../long-term/embedding-index'
import { prepareEntityVectors } from '../recall/entity-vector-preparation'
import { entityVectorDocument, searchEntityVectorSeeds } from '../recall/entity-vector-seeds'
import { createGraphRelationReadPort } from '../repository/relation-read-port'
import { createL2AdjacencyIndex } from '../projection/l2-adjacency-index'
import { V4_SCALAR_MAPPING_POLICY } from '../adapters/v4-semantic-adapter'
import type { V4GraphMemoryOptions } from '../adapters/v4-graph-memory'
import type { GraphRelationEdge } from '../domain/relation-types'
import { entityClaimIndex } from '../projection/entity-claim-index'

const value = <T>(result: GraphResult<T>): T => { if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`); return result.value }
const model = 'toy-entity-routing-only'
async function seed(f: Awaited<ReturnType<typeof createAcceptedL1Fixture>> | Awaited<ReturnType<typeof createNativeL2Fixture>>) {
  const index = createMemoryEmbeddingIndex(), facts = createMemoryEmbeddingIndex()
  const bundle = f.projection.snapshot()!.semanticBundle
  let queries = 0
  const lookups: string[] = []
  await prepareEntityVectors({ bundle, index, model, embed: async () => [1, 0], isCurrent: () => true })
  facts.putBatch(f.repository.snapshot().facts.map(fact => ({ memoryId: fact.id, model, content: fact.canonicalText, vector: [1, 0] })))
  const embedQuery = async () => { queries++; return { model, vector: [1, 0] } }
  const options = { ...f.options, retrievalMode: 'entity-vector' as const,
    entitySemantic: { model, dimensions: 2, index, embedQuery },
    semantic: { model, dimensions: 2, index: { get: (id: string, m: string, text: string) => {
      lookups.push(id); return facts.get(id, m, text)
    } }, embedQuery } }
  return { options, index, facts, lookups, queries: () => queries, bundle }
}

/** Toy vectors prove routing/isolation only; they do not measure learned-model quality. */
export async function runEntityVectorRegression() {
  const checks: { id: string; passed: boolean; error?: string }[] = []
  const test = async (id: string, run: () => unknown | Promise<unknown>) => {
    try { await run(); checks.push({ id, passed: true }) } catch (error) { checks.push({ id, passed: false, error: String(error) }) }
  }
  await test('L1-entity-entry-returns-exact-claim-and-reuses-query-vector', async () => {
    const f = await createAcceptedL1Fixture(), s = await seed(f)
    const result = value(await createV4GraphMemory(s.options).recall({ ...f.request, query: 'Where does Alex work?' }))
    assert.equal(result.evidence.claims.length, 1)
    assert.deepEqual(result.evidence.claims[0]!.ref, f.l1.claims()[0]!.ref)
    assert.ok(result.trace.searchScope.includes('seed-entry:entity-vector'))
    assert.ok(result.trace.searchScope.includes('claim-selection:local-vector'))
    assert.ok(!result.trace.searchScope.includes('BM25')); assert.equal(result.trace.usage.edges, 0)
    assert.equal(s.queries(), 1)
  })
  await test('L2-entity-entry-expands-reviewed-local-relations', async () => {
    const f = await createNativeL2Fixture(); value(await f.publish()); const s = await seed(f)
    const before = f.nativePersistence.load()
    const result = value(await createV4L2Memory({ ...s.options, relationPersistence: f.options.relationPersistence }).recall(f.request))
    assert.equal(result.evidence.relations!.length, 1)
    assert.ok(result.trace.searchScope.includes('seed-entry:entity-vector'))
    assert.ok(result.trace.searchScope.includes('relation-read:adjacency-index'))
    assert.equal(s.queries(), 1); assert.equal(f.nativePersistence.load(), before)
  })
  await test('L2-direct-question-also-uses-entity-entry', async () => {
    const f = await createNativeL2Fixture(), s = await seed(f)
    const result = value(await createV4L2Memory({ ...s.options, relationPersistence: f.options.relationPersistence }).recall({ ...f.request, query: 'Acme' }))
    assert.ok(result.evidence.claims.length > 0); assert.equal(result.trace.usage.edges, 0)
    assert.ok(result.trace.searchScope.includes('seed-entry:entity-vector'))
  })
  for (const scenario of ['empty-entity-cache', 'low-entity-score', 'empty-local-cache', 'no-model', 'withdraw', 'deny', 'time', 'owner', 'delete-source'] as const)
    await test(`L1-${scenario}-does-not-use-global-claim-fallback`, async () => {
      const f = await createAcceptedL1Fixture(), s = await seed(f)
      const options: V4GraphMemoryOptions = s.options
      let request = f.request
      if (scenario === 'low-entity-score' || scenario === 'empty-local-cache') request = { ...request, query: 'Where does Alex work?' }
      if (scenario === 'empty-entity-cache') s.index.removeByModel(model)
      if (scenario === 'low-entity-score') options.entitySemantic = { ...s.options.entitySemantic, embedQuery: async () => ({ model, vector: [0, 1] }) }
      if (scenario === 'empty-local-cache') s.facts.removeByModel(model)
      if (scenario === 'no-model') options.entitySemantic = undefined
      if (scenario === 'withdraw') f.withdraw()
      if (scenario === 'deny') f.deny()
      if (scenario === 'time') request = { ...request, temporal: { ...request.temporal, valid: { kind: 'at', at: 1 } } }
      if (scenario === 'owner') request = { ...request, scope: { ...request.scope, ownerId: 'other' } }
      if (scenario === 'delete-source') f.repository.transaction(snapshot => {
        snapshot.episodes[0]!.contentState = 'deleted'; snapshot.episodes[0]!.deletedAt = f.options.now(); delete snapshot.episodes[0]!.content
      })
      const result = await createV4GraphMemory(options).recall(request)
      assert.ok(!result.ok || result.value.evidence.claims.length === 0)
      if (scenario !== 'empty-local-cache' && scenario !== 'low-entity-score') assert.equal(s.lookups.length, 0)
    })
  await test('scalar-only-memory-does-not-invent-an-entity', async () => {
    const f = createL2HostFixture(); await f.publish()
    const semantic = { model, dimensions: 2, index: { get: () => [1, 0] }, embedQuery: async () => ({ model, vector: [1, 0] }) }
    const result = value(await createV4L2Memory({ ...f.options, retrievalMode: 'entity-vector', semantic, entitySemantic: semantic }).recall(f.request()))
    assert.equal(result.evidence.claims.length, 0); assert.equal(result.trace.usage.edges, 0)
  })
  await test('permission-revoked-during-embedding-does-not-return-evidence', async () => {
    const f = await createAcceptedL1Fixture(), s = await seed(f)
    s.options.entitySemantic.embedQuery = async () => { f.deny(); return { model, vector: [1, 0] } }
    assert.equal((await createV4GraphMemory(s.options).recall(f.request)).ok, false)
  })
  await test('cache-reuses-unchanged-vectors-and-removes-withdrawn-entities', async () => {
    const f = await createAcceptedL1Fixture(), s = await seed(f)
    const cached = await prepareEntityVectors({ bundle: s.bundle, index: s.index, model,
      embed: async () => { throw new Error('must use cache') }, isCurrent: () => true })
    assert.equal(cached.prepared, 0)
    const doc = entityVectorDocument(s.bundle.entities[0]!)
    await prepareEntityVectors({ bundle: { ...s.bundle, entities: [] }, index: s.index, model, embed: async () => [1, 0], isCurrent: () => true })
    assert.equal(s.index.get(doc.id, model, doc.canonicalText), undefined)
  })
  await test('stale-preparation-never-publishes-late-vector', async () => {
    const f = await createAcceptedL1Fixture(), index = createMemoryEmbeddingIndex(); let current = true
    await assert.rejects(prepareEntityVectors({ bundle: f.projection.snapshot()!.semanticBundle, index, model,
      embed: async () => { current = false; return [1, 0] }, isCurrent: () => current }))
    const doc = entityVectorDocument(f.projection.snapshot()!.semanticBundle.entities[0]!)
    assert.equal(index.get(doc.id, model, doc.canonicalText), undefined)
  })
  await test('entity-version-and-name-changes-do-not-reuse-an-old-vector', async () => {
    const f = await createAcceptedL1Fixture(), s = await seed(f), original = s.bundle.entities[0]!
    for (const entity of [{ ...original, ref: { ...original.ref, version: original.ref.version + 1 } },
      { ...original, canonicalName: 'Changed name' }]) {
      const doc = entityVectorDocument(entity)
      assert.equal(s.index.get(doc.id, model, doc.canonicalText), undefined)
    }
  })
  await test('entity-policy-denial-blocks-local-fact-ranking', async () => {
    const f = await createAcceptedL1Fixture(), s = await seed(f), acceptedBundle = f.options.acceptedBundle
    s.options.acceptedBundle = () => {
      const bundle = acceptedBundle()!
      return { ...bundle, entities: bundle.entities.map(entity => ({ ...entity, sensitivity: 'secret' as const })) }
    }
    const r = await createV4GraphMemory(s.options).recall(f.request)
    assert.ok(!r.ok || !r.value.evidence.claims.length); assert.equal(s.lookups.length, 0)
  })
  await test('entity-adjacency-is-reused-only-for-the-pinned-publication', async () => {
    const f = await createAcceptedL1Fixture(), projection = f.projection.snapshot()!
    const first = entityClaimIndex(projection)
    const second = entityClaimIndex(structuredClone(projection))
    assert.equal(second.index, first.index); assert.equal(second.reused, true)
    const newer = { ...projection, manifest: { ...projection.manifest, manifestId: 'changed-publication' },
      semanticBundle: { ...projection.semanticBundle, claims: [] } }
    assert.equal(entityClaimIndex(newer).index.size, 0)
  })
  await test('entity-adjacency-never-scores-an-unconnected-fact', async () => {
    const f = await createAcceptedL1Fixture(), s = await seed(f), projection = f.projection.snapshot()!
    const claim = projection.semanticBundle.claims[0]!, fact = f.repository.snapshot().facts[0]!
    const unrelated = { ...claim, ref: { ...claim.ref, id: 'unrelated' }, fact: { ...claim.fact, id: 'unrelated-fact' }, atom: { ...claim.atom, args: {} } }
    const result = await searchEntityVectorSeeds({ query: 'Where does Alex work?', projection,
      entries: [{ claim, fact }, { claim: unrelated, fact: { id: 'unrelated-fact', canonicalText: 'Acme' } }],
      scope: f.request.scope, temporal: f.request.temporal, sharePolicies: f.request.sharePolicies, sensitivities: f.request.sensitivities,
      entitySemantic: s.options.entitySemantic, claimSemantic: s.options.semantic, entityLimit: 4, remainingMs: 2000, canReadEntity: () => true })
    assert.deepEqual(result.hits.map(h => h.id), [fact.id]); assert.deepEqual(s.lookups, [fact.id])
  })
  await test('L1-top-k-keeps-budget-and-truncation', async () => {
    const f = await createNativeL2Fixture(), s = await seed(f)
    const result = value(await createV4GraphMemory(s.options).recall({ ...f.request, query: 'Acme', budget: { ...V4_GRAPH_BUDGET, maxSeeds: 1 } }))
    assert.equal(result.evidence.claims.length, 1); assert.equal(result.trace.completeness, 'incomplete')
  })
  await test('L2-pages-use-local-adjacency-and-cheap-live-manifest-check', async () => {
    const f = await createNativeL2Fixture(); value(await f.publish())
    const p = value(f.port.prepareRelations(f.request.scope))
    const opened = value(await p.core.l1.openView({ access: f.access, temporal: f.request.temporal, budget: f.request.budget,
      expectedManifestId: p.core.l1.snapshot()!.manifest.manifestId, policyVersion: V4_SCALAR_MAPPING_POLICY }))
    let snapshots = 0
    const read = createGraphRelationReadPort({ repository: { ...p.repository, snapshot: () => { snapshots++; return p.repository.snapshot() } },
      isCoreViewLive: p.core.l1.isViewLive, verifySources: async () => ({ ok: true, value: undefined }) })
    const view = value(await read.openView({ coreView: opened, expectedRelationManifestId: p.repository.snapshot().manifest.manifestId }))
    const relation = p.repository.snapshot().relations[0]!
    const query = { claim: relation.from, direction: 'both' as const, kinds: [relation.kind], limit: 1, maxScanned: 1 }
    assert.equal(value(await view.neighbors(query)).items.length, 1)
    assert.equal(value(await view.resolveRelations([relation.ref])).length, 1)
    assert.equal(snapshots, 1)
    assert.equal(value(await view.neighbors({ ...query, claim: { ...relation.from, version: relation.from.version + 1 } })).items.length, 0)
    await view.close(); assert.equal((await view.neighbors(query)).ok, false); await opened.close()
  })
  await test('adjacency-is-exact-version-local-with-many-disconnected-edges', () => {
    const ref = (id: string) => ({ kind: 'claim' as const, id, version: 1 })
    const edges = Array.from({ length: 5000 }, (_, i) => ({ id: `e-${i}`, from: ref(`a-${i}`), to: ref(`b-${i}`) } as GraphRelationEdge))
    const index = createL2AdjacencyIndex(edges)
    // Mutating the input array after construction cannot force a global rescan.
    edges.length = 0
    assert.equal(index.candidates(ref('a-123')).length, 1)
    assert.equal(index.candidates(ref('b-123')).length, 1)
    assert.equal(index.candidates({ ...ref('a-123'), version: 2 }).length, 0)
  })
  return { kind: 'synthetic-routing-boundary-tests-not-model-quality', checks }
}
