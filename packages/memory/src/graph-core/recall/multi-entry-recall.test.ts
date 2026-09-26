import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { MEMORY_GRAPH_PROTOCOL_VERSION } from '@continuum-memory/contracts'
import type { GraphResult } from '@continuum-memory/contracts'
import type { GraphRecallReadView as GraphReadView } from '../ports/graph-recall-ports'
import type { GraphRelationValidationInput } from '../domain/validation'
import { createFeverAbsenceFixture, FEVER_ABSENCE_DAY, FEVER_ABSENCE_RECORDED_AT, FEVER_ABSENCE_REVOKED_AT } from '../fixtures/fever-absence'
import { createInMemoryGraph } from '../repository/in-memory-graph'
import { createOneHopGraphRecall } from './one-hop-recall'
import type { QueryOneHopGraphRecallRequest } from './one-hop-recall'

function value<T>(result: GraphResult<T>): T {
  if (!result.ok) throw new Error(result.error.code)
  return result.value
}
function addRoot(data: GraphRelationValidationInput, id: string) {
  const claim = structuredClone(data.bundle.claims[1]!)
  Object.assign(claim, { ref: { kind: 'claim', id, version: 1 }, fact: { kind: 'v4-fact', id: `fact-${id}`, version: 1 } })
  const relation = structuredClone(data.bundle.relations[0]!)
  Object.assign(relation, { ref: { kind: 'relation', id: `relation-${id}`, version: 1 }, to: claim.ref })
  Object.assign(data.bundle, { claims: [...data.bundle.claims, claim], relations: [...data.bundle.relations, relation] })
  Object.assign(data, {
    factVersions: [...data.factVersions, { ref: claim.fact, scope: claim.scope, canonicalText: data.factVersions[1]!.canonicalText }],
    edges: [...data.edges, { id: `edge-${id}`, layer: 'semantic', kind: relation.kind,
      from: relation.from, to: relation.to, relationRef: relation.ref }],
  })
  return claim
}
function setup(data = createFeverAbsenceFixture(), maxSeedScanned = 10000) {
  const access = { accessContextId: 'test', authorizationVersion: 'v1', scope: data.bundle.scope,
    sharePolicies: ['allow-remote' as const], sensitivities: ['normal' as const] }
  const store = createInMemoryGraph({ data, resolveAccess: () => access, countTokens: () => 1, clock: () => 0, maxSeedScanned,
    manifest: { protocolVersion: MEMORY_GRAPH_PROTOCOL_VERSION, schemaVersion: 1, manifestId: 'm1', sourceBundleId: data.bundle.bundleId,
      scope: data.bundle.scope, sourceRevisions: data.bundle.revisions,
      semanticFingerprint: createHash('sha256').update(JSON.stringify(data.bundle)).digest('hex'),
      builderVersion: 'test', navigationRevision: 0, createdAt: FEVER_ABSENCE_RECORDED_AT, state: 'ready' } })
  let lastView: GraphReadView | undefined
  const openView = vi.fn(async (request: QueryOneHopGraphRecallRequest['view']) => {
    const result = await store.openView(request)
    if (result.ok) { lastView = result.value; vi.spyOn(lastView, 'close'); vi.spyOn(lastView, 'neighbors') }
    return result
  })
  const service = createOneHopGraphRecall({ readPort: { openView }, seedPort: store.seedPort, evidenceReader: store.evidenceReader })
  const request: QueryOneHopGraphRecallRequest = { recallId: 'multi-root', query: '张三为什么没有上班？', view: {
    access, expectedManifestId: 'm1', policyVersion: 'multi-entry-test',
    temporal: { valid: { kind: 'at', at: FEVER_ABSENCE_DAY + 1 }, knownAt: FEVER_ABSENCE_RECORDED_AT + 1 },
    budget: { maxSeeds: 3, maxNodes: 10, maxEdges: 20, maxHops: 1, maxRuleBindings: 0, maxProofSteps: 0,
      maxElapsedMs: 1000, maxEvidenceTokens: 100 },
  } }
  return { store, service, request, data, openView, view: () => lastView! }
}

describe('multi-entry candidate search and shared one-hop roots', () => {
  it('expands multiple roots with one view and deduplicates their shared cause and source', async () => {
    const data = createFeverAbsenceFixture()
    addRoot(data, 'C4')
    const s = setup(data)
    const result = value(await s.service.recallQuery({ ...s.request,
      view: { ...s.request.view, budget: { ...s.request.view.budget, maxEvidenceTokens: 4 } } }))
    expect(result.selection).toBe('top-k')
    expect(result.seeds.items.map(item => item.ref.id)).toEqual(['C2', 'C4'])
    expect(result.recall!.claims.map(item => item.record.ref.id)).toEqual(['C2', 'C1', 'C4'])
    expect(result.recall!.groups).toHaveLength(2)
    expect(result.recall!.sources).toHaveLength(1)
    expect(result.recall!.searchScope.seeds.map(ref => ref.id)).toEqual(['C2', 'C4'])
    expect(result.recall!.seedProgress.map(item => item.completion)).toEqual(['complete', 'complete'])
    expect(result.recall!.scannedEdges).toBe(2)
    expect(s.openView).toHaveBeenCalledOnce()
    expect(s.view().close).toHaveBeenCalledOnce()
    expect(vi.mocked(s.view().neighbors).mock.calls.map(([query]) => query.node.id)).toEqual(['C2', 'C4'])
  })

  it('retains all implemented entry origins but counts the same Claim only once', async () => {
    const s = setup()
    const claim = s.data.bundle.claims[1]!.ref
    const result = value(await s.service.recallQuery({ ...s.request,
      view: { ...s.request.view, budget: { ...s.request.view.budget, maxSeeds: 1 } },
      seedEntries: { claims: [claim, claim], entities: [s.data.bundle.entities[0]!.ref],
        relations: [s.data.bundle.relations[0]!.ref, s.data.bundle.relations[0]!.ref] } }))
    expect(result.seeds.items).toHaveLength(1)
    expect(result.seeds.items[0]!.origins!.map(origin => origin.kind).sort())
      .toEqual(['claim-ref', 'claim-text', 'entity-ref', 'relation-ref'])
    expect(result.recall!.groups).toHaveLength(1)
    expect(result.seeds.scanned).toBe(4) // Three Claims and one unique relation lookup.
  })

  it('accepts a host-resolved Claim entry even when its paraphrase has insufficient lexical overlap', async () => {
    const s = setup()
    const query = '没有出勤的原因是什么？'
    expect(value(await s.service.recallQuery({ ...s.request, query })).status).toBe('no-match')
    const result = value(await s.service.recallQuery({ ...s.request, query, seedEntries: { claims: [s.data.bundle.claims[1]!.ref] } }))
    expect(result.seeds.items[0]).toMatchObject({ ref: { id: 'C2' }, route: 'structured', relevance: 1 })
    expect(result.recall!.groups).toHaveLength(1)
  })

  it('uses relation direction to select the target endpoint, not to fabricate a new fact', async () => {
    const s = setup()
    const entries = { relations: [s.data.bundle.relations[0]!.ref] }
    const incoming = value(await s.service.recallQuery({ ...s.request, query: '没有出勤的原因是什么？', seedEntries: entries }))
    expect(incoming.seeds.items.map(item => item.ref.id)).toEqual(['C2'])
    expect(incoming.recall!.relations[0]!.from.id).toBe('C1')
    const outgoing = value(await s.service.recallQuery({ ...s.request, query: '高热造成了什么影响？', seedEntries: entries }))
    expect(outgoing.seeds.items.map(item => item.ref.id)).toEqual(['C1'])
    expect(outgoing.recall!.relations[0]!.to.id).toBe('C2')
    const wrongKind = value(await s.service.recallQuery({ ...s.request, query: '缺勤之前发生了什么？', seedEntries: entries }))
    expect(wrongKind.status).toBe('no-match')
  })

  it('does not use entity membership alone to return unrelated events', async () => {
    const s = setup()
    const result = value(await s.service.recallQuery({ ...s.request, query: '张三为什么喜欢音乐？',
      seedEntries: { entities: [s.data.bundle.entities[0]!.ref] } }))
    expect(result.status).toBe('no-match')
  })

  it('filters inaccessible explicit Claims and wrong versions just like text candidates', async () => {
    const data = createFeverAbsenceFixture()
    const hidden = addRoot(data, 'C4')
    Object.assign(hidden, { sensitivity: 'private' })
    const s = setup(data)
    const result = value(await s.service.recallQuery({ ...s.request, seedEntries: { claims: [hidden.ref, { ...hidden.ref, version: 99 }] } }))
    expect(result.seeds.items.map(item => item.ref.id)).toEqual(['C2'])
    expect(result.recall!.claims.some(item => item.record.ref.id === 'C4')).toBe(false)
  })

  it('applies entity, explicit date and polarity constraints to structured entries too', async () => {
    const s = setup()
    const seedEntries = { claims: [s.data.bundle.claims[0]!.ref, s.data.bundle.claims[1]!.ref] }
    const negative = value(await s.service.recallQuery({ ...s.request, seedEntries }))
    expect(negative.seeds.items.map(item => item.ref.id)).toEqual(['C2'])
    const wrongPerson = value(await s.service.recallQuery({ ...s.request, seedEntries,
      constraints: { entities: [{ kind: 'entity', id: 'other', version: 1 }] } }))
    expect(wrongPerson.status).toBe('no-match')
    const wrongDate = value(await s.service.recallQuery({ ...s.request, seedEntries, query: '张三2026-09-10为什么没有上班？' }))
    expect(wrongDate.status).toBe('no-match')
  })

  it('does not use revoked or source-deleted relations as seed entries', async () => {
    const s = setup(createFeverAbsenceFixture(true))
    const request = { ...s.request, query: '没有出勤的原因是什么？', seedEntries: { relations: s.data.bundle.relations.map(item => item.ref) },
      view: { ...s.request.view, temporal: { ...s.request.view.temporal, knownAt: FEVER_ABSENCE_REVOKED_AT } } }
    expect(value(await s.service.recallQuery(request)).status).toBe('no-match')
    s.store.revokeSource('E1')
    expect(value(await s.service.recallQuery({ ...request, view: s.request.view })).status).toBe('no-match')
  })

  it('includes relation lookup in the cumulative scan ceiling and does not emit a partial ranking', async () => {
    const s = setup(undefined, 3)
    const result = value(await s.service.recallQuery({ ...s.request, seedEntries: { relations: [s.data.bundle.relations[0]!.ref] } }))
    expect(result).toMatchObject({ status: 'seed-search-incomplete', recall: null,
      seeds: { items: [], scanned: 3, completion: 'budget-exhausted' } })
    expect(s.view().neighbors).not.toHaveBeenCalled()
  })

  it('preserves earlier groups when a later root cannot fit its evidence budget', async () => {
    const data = createFeverAbsenceFixture()
    addRoot(data, 'C4')
    const s = setup(data)
    const result = value(await s.service.recallQuery({ ...s.request,
      view: { ...s.request.view, budget: { ...s.request.view.budget, maxEvidenceTokens: 3 } } }))
    expect(result.recall).toMatchObject({ completeness: 'incomplete', stopReason: 'budget-exhausted' })
    expect(result.recall!.groups).toHaveLength(1)
    expect(result.recall!.claims.map(item => item.record.ref.id)).toEqual(['C2', 'C1'])
    expect(result.recall!.seedProgress.map(item => item.completion)).toEqual(['complete', 'incomplete'])
  })

  it('reports not-started roots when earlier expansion exhausts the shared edge budget', async () => {
    const data = createFeverAbsenceFixture()
    addRoot(data, 'C4')
    addRoot(data, 'C5')
    const s = setup(data)
    const result = value(await s.service.recallQuery({ ...s.request,
      view: { ...s.request.view, budget: { ...s.request.view.budget, maxEdges: 1 } } }))
    expect(result.recall!.seedProgress.map(item => item.completion)).toEqual(['complete', 'incomplete', 'not-started'])
    expect(result.recall!.groups).toHaveLength(1)
    expect(result.recall!.scannedEdges).toBe(1)
    expect(result.recall!.completeness).toBe('incomplete')
  })

  it('does not exceed maxSeeds and preserves single-seed behavior when it is one', async () => {
    const data = createFeverAbsenceFixture()
    addRoot(data, 'C4')
    const s = setup(data)
    const result = value(await s.service.recallQuery({ ...s.request,
      view: { ...s.request.view, budget: { ...s.request.view.budget, maxSeeds: 1 } } }))
    expect(result.seeds.items).toHaveLength(1)
    expect(result.recall!.searchScope.seeds).toHaveLength(1)
    expect(s.view().neighbors).toHaveBeenCalledOnce()
  })

  it('deduplicates a relation reached from both endpoints, including its token cost', async () => {
    const s = setup()
    const result = value(await s.service.recallQuery({ ...s.request, query: '发烧相关的记忆', direction: 'both', kinds: ['causal'],
      seedEntries: { claims: [s.data.bundle.claims[0]!.ref, s.data.bundle.claims[1]!.ref] },
      view: { ...s.request.view, budget: { ...s.request.view.budget, maxEvidenceTokens: 3 } } }))
    expect(result.recall!.searchScope.seeds).toHaveLength(2)
    expect(result.recall!.groups).toHaveLength(1)
    expect(result.recall!.sources).toHaveLength(1)
    expect(result.recall!.claims).toHaveLength(2)
    expect(result.recall!.scannedEdges).toBe(2) // Two real scans, one output group.
  })
})
