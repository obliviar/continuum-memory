import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { MEMORY_GRAPH_PROTOCOL_VERSION } from '@continuum-memory/contracts'
import type { GraphResult } from '@continuum-memory/contracts'
import type { GraphRelationValidationInput } from '../domain/validation'
import type { GraphProjectionManifest } from '../domain/types'
import {
  createFeverAbsenceFixture, FEVER_ABSENCE_DAY,
  FEVER_ABSENCE_RECORDED_AT, FEVER_ABSENCE_REVOKED_AT,
} from '../fixtures/fever-absence'
import type { GraphAccessContext, GraphRecallNeighborQuery as GraphNeighborQuery, GraphRecallOpenViewRequest as GraphOpenViewRequest } from '../ports/graph-recall-ports'
import { createInMemoryGraph } from './in-memory-graph'
import type { InMemoryGraphOptions } from './in-memory-graph'

function value<T>(result: GraphResult<T>): T {
  if (!result.ok) throw new Error(result.error.code)
  return result.value
}

function setup(data = createFeverAbsenceFixture(), extra: Partial<InMemoryGraphOptions> = {}) {
  let grant: GraphAccessContext | undefined = {
    accessContextId: 'local-test', authorizationVersion: 'auth-v1', scope: data.bundle.scope,
    sharePolicies: ['allow-remote'], sensitivities: ['normal'],
  }
  const manifest: GraphProjectionManifest = {
    protocolVersion: MEMORY_GRAPH_PROTOCOL_VERSION, schemaVersion: 1, manifestId: 'manifest-1',
    sourceBundleId: data.bundle.bundleId, scope: data.bundle.scope,
    sourceRevisions: data.bundle.revisions,
    semanticFingerprint: createHash('sha256').update(JSON.stringify(data.bundle)).digest('hex'),
    builderVersion: 'fixture-projection-v1', navigationRevision: 0,
    createdAt: FEVER_ABSENCE_REVOKED_AT, state: 'ready',
  }
  const request: GraphOpenViewRequest = {
    access: structuredClone(grant), expectedManifestId: manifest.manifestId, policyVersion: 'direct-test-v1',
    temporal: { valid: { kind: 'at', at: FEVER_ABSENCE_DAY + 1000 }, knownAt: FEVER_ABSENCE_RECORDED_AT + 1000 },
    budget: { maxSeeds: 5, maxNodes: 20, maxEdges: 20, maxHops: 2, maxRuleBindings: 0,
      maxProofSteps: 0, maxElapsedMs: 1000, maxEvidenceTokens: 1000 },
  }
  const store = createInMemoryGraph({
    data, manifest, resolveAccess: () => grant,
    // Deliberate deterministic TEST tokenizer: each output is one budget unit.
    // Production must inject its real tokenizer.
    countTokens: text => text.length === 0 ? 0 : 1, clock: () => 0,
    ...extra,
  })
  return { store, request, data, setGrant: (next?: GraphAccessContext) => { grant = next } }
}

function query(overrides: Partial<GraphNeighborQuery> = {}): GraphNeighborQuery {
  return { node: { kind: 'claim', id: 'C2', version: 1 }, layer: 'semantic', direction: 'in',
    kinds: ['causal'], limit: 10, maxScanned: 10, ...overrides }
}

function addSecondRelation(data: GraphRelationValidationInput): void {
  const relation = structuredClone(data.bundle.relations[0]!)
  Object.assign(relation, { ref: { kind: 'relation', id: 'R2', version: 1 } })
  const edge = structuredClone(data.edges[0]!)
  Object.assign(edge, { id: 'edge-R2-v1', relationRef: relation.ref })
  Object.assign(data.bundle, { relations: [...data.bundle.relations, relation] })
  Object.assign(data, { edges: [...data.edges, edge] })
}

describe('In-memory direct relation read view', () => {
  it('reads the cause edge, relation, claim, exact fact and original source', async () => {
    const { store, request, data } = setup()
    const view = value(await store.openView(request))
    const page = value(await view.neighbors(query()))
    expect(page.completion).toBe('complete')
    expect(page.scanned).toBe(1)
    expect(page.items.map(edge => [edge.from.id, edge.to.id])).toEqual([['C1', 'C2']])
    const relation = value(await view.resolveRelations([data.bundle.relations[0]!.ref]))[0]!
    const claim = value(await view.resolveClaims([relation.from]))[0]!
    expect(value(await store.evidenceReader.resolveFactVersions(view, [claim.fact]))[0]!.canonicalText).toContain('发烧')
    expect(value(await store.evidenceReader.readSources(view, [relation.evidence[0].source]))[0]!.content).toContain('因为发烧')
  })

  it('preserves edge direction while supporting inverse traversal', async () => {
    const { store, request } = setup()
    const view = value(await store.openView(request))
    expect(value(await view.neighbors(query({ direction: 'out' }))).items).toEqual([])
    const forward = value(await view.neighbors(query({ node: { kind: 'claim', id: 'C1', version: 1 }, direction: 'out' })))
    expect(forward.items[0]!.to.id).toBe('C2')
    expect(value(await view.neighbors(query({ kinds: ['before'] }))).items).toEqual([])
    expect(value(await view.neighbors(query({ kinds: [] }))).items).toEqual([])
  })

  it('deduplicates BOTH-direction self-loops', async () => {
    const data = createFeverAbsenceFixture()
    Object.assign(data.bundle.relations[0]!, { to: data.bundle.claims[0]!.ref })
    Object.assign(data.edges[0]!, { to: data.bundle.claims[0]!.ref })
    const { store, request } = setup(data)
    const view = value(await store.openView(request))
    expect(value(await view.neighbors(query({ node: data.bundle.claims[0]!.ref, direction: 'both' }))).items).toHaveLength(1)
  })

  it('filters the different-day distractor and does not return shortened exact-read arrays', async () => {
    const { store, request, data } = setup()
    const view = value(await store.openView(request))
    const result = await view.resolveClaims([data.bundle.claims[0]!.ref, data.bundle.claims[2]!.ref])
    expect(result).toMatchObject({ ok: false, error: { code: 'source-unavailable' } })
  })

  it('rejects a missing exact claim version', async () => {
    const { store, request } = setup()
    const view = value(await store.openView(request))
    expect(await view.resolveClaims([{ kind: 'claim', id: 'C1', version: 99 }]))
      .toMatchObject({ ok: false, error: { code: 'source-unavailable' } })
  })

  it('uses half-open valid-time boundaries and overlap queries', async () => {
    const { store, request, data } = setup()
    const ref = data.bundle.claims[0]!.ref
    const end = FEVER_ABSENCE_DAY + 86400000
    const outside = value(await store.openView({ ...request, temporal: { ...request.temporal, valid: { kind: 'at', at: end } } }))
    expect((await outside.resolveClaims([ref])).ok).toBe(false)
    const inside = value(await store.openView({ ...request, temporal: { ...request.temporal, valid: { kind: 'overlap', from: end - 1, to: end } } }))
    expect((await inside.resolveClaims([ref])).ok).toBe(true)
    const touching = value(await store.openView({ ...request, temporal: { ...request.temporal, valid: { kind: 'overlap', from: end, to: end + 1 } } }))
    expect((await touching.resolveClaims([ref])).ok).toBe(false)
  })

  it('distinguishes event time from knowledge time and does not revive revoked relations', async () => {
    const { store, request, data } = setup(createFeverAbsenceFixture(true))
    const before = value(await store.openView({ ...request, temporal: { ...request.temporal, knownAt: FEVER_ABSENCE_REVOKED_AT - 1 } }))
    expect(value(await before.neighbors(query())).items).toHaveLength(1)
    const after = value(await store.openView({ ...request, temporal: { ...request.temporal, knownAt: FEVER_ABSENCE_REVOKED_AT } }))
    expect(value(await after.neighbors(query())).items).toHaveLength(0)
    expect((await after.resolveRelations([data.bundle.relations[0]!.ref])).ok).toBe(false)
    const notKnown = value(await store.openView({ ...request, temporal: { ...request.temporal, knownAt: FEVER_ABSENCE_RECORDED_AT - 1 } }))
    expect((await notKnown.resolveClaims([data.bundle.claims[0]!.ref])).ok).toBe(false)
  })

  it.each([
    { assertion: 'hypothesis' }, { status: 'revoked' }, { support: 'unknown' },
    { review: { status: 'candidate' } }, { validTime: { kind: 'unknown' } },
  ])('keeps valid but ineligible relation records out of neighbors: %j', async (patch) => {
    const data = createFeverAbsenceFixture()
    Object.assign(data.bundle.relations[0]!, patch)
    const { store, request } = setup(data)
    const view = value(await store.openView(request))
    expect(value(await view.neighbors(query())).items).toEqual([])
    expect((await view.resolveRelations([data.bundle.relations[0]!.ref])).ok).toBe(false)
  })

  it('does not reveal a reviewed decision before its review timestamp', async () => {
    const data = createFeverAbsenceFixture()
    Object.assign(data.bundle.relations[0]!, { review: { status: 'accepted', reviewedAt: FEVER_ABSENCE_REVOKED_AT, reviewer: 'test' } })
    const { store, request } = setup(data)
    expect(value(await value(await store.openView(request)).neighbors(query())).items).toEqual([])
  })

  it('intersects requested privacy filters with host grants', async () => {
    const data = createFeverAbsenceFixture()
    Object.assign(data.bundle.claims[0]!, { sensitivity: 'private' })
    const { store, request } = setup(data)
    const view = value(await store.openView({ ...request, access: { ...request.access, sensitivities: ['normal', 'private'] } }))
    expect(value(await view.neighbors(query())).items).toEqual([])
    expect((await view.resolveClaims([data.bundle.claims[0]!.ref])).ok).toBe(false)
    expect((await store.evidenceReader.resolveFactVersions(view, [data.bundle.claims[0]!.fact])).ok).toBe(false)
  })

  it('does not broaden session authorization and filters other sessions', async () => {
    const data = createFeverAbsenceFixture()
    Object.assign(data.bundle.relations[0]!, { scope: { ...data.bundle.scope, sessionId: 'A' } })
    const { store, request, setGrant } = setup(data)
    setGrant({ ...request.access, scope: { ...request.access.scope, sessionId: 'B' } })
    expect(await store.openView(request)).toMatchObject({ ok: false, error: { code: 'scope-denied' } })
    const view = value(await store.openView({ ...request, access: { ...request.access, scope: { ...request.access.scope, sessionId: 'B' } } }))
    expect(value(await view.neighbors(query())).items).toEqual([])
  })

  it('rechecks authorization and its revision after opening a view', async () => {
    const { store, request, setGrant } = setup()
    const view = value(await store.openView(request))
    setGrant({ ...request.access, authorizationVersion: 'auth-v2' })
    expect(await view.neighbors(query())).toMatchObject({ ok: false, error: { code: 'scope-denied' } })
    setGrant(undefined)
    expect(await view.resolveClaims([])).toMatchObject({ ok: false, error: { code: 'scope-denied' } })
  })

  it('rejects fabricated access contexts and handles host lookup failure safely', async () => {
    const { store, request } = setup(undefined, { resolveAccess: () => { throw new Error('private internal error') } })
    expect(await store.openView(request)).toEqual({ ok: false, error: { code: 'scope-denied', message: 'Host authorization is unavailable' } })
    const normal = setup()
    expect((await normal.store.openView({ ...normal.request, access: { ...normal.request.access, accessContextId: 'fake' } })).ok).toBe(false)
  })

  it('blocks deleted sources even for historical reads and subsequent fact resolution', async () => {
    const { store, request, data } = setup(createFeverAbsenceFixture(true))
    const view = value(await store.openView(request))
    store.revokeSource('E1')
    expect((await view.resolveClaims([data.bundle.claims[0]!.ref])).ok).toBe(false)
    expect((await store.evidenceReader.readSources(view, [data.bundle.claims[0]!.evidence[0].source])).ok).toBe(false)
    expect((await store.evidenceReader.resolveFactVersions(view, [data.bundle.claims[0]!.fact])).ok).toBe(false)
  })

  it('serves only registered evidence spans, not arbitrary slices or whole episodes', async () => {
    const data = createFeverAbsenceFixture()
    const claim = data.bundle.claims[0]!
    const original = claim.evidence[0].source
    const span = { ...original, locator: { kind: 'text-span' as const, unit: 'utf16' as const, start: 0, end: 2 } }
    Object.assign(claim, { evidence: [{ source: span, role: 'supports', strength: 'direct' }] })
    const { store, request } = setup(data)
    const view = value(await store.openView(request))
    expect(value(await store.evidenceReader.readSources(view, [span]))[0]!.content).toBe('张三')
    expect((await store.evidenceReader.readSources(view, [{ ...original, locator: { kind: 'whole-content' } }])).ok).toBe(false)
  })

  it('invalidates existing and future views and honors close', async () => {
    const { store, request } = setup()
    const closed = value(await store.openView(request))
    await closed.close()
    expect(await closed.neighbors(query())).toMatchObject({ ok: false, error: { code: 'view-closed' } })
    const view = value(await store.openView(request))
    store.invalidate()
    expect(await view.neighbors(query())).toMatchObject({ ok: false, error: { code: 'stale-projection' } })
    expect(await store.openView(request)).toMatchObject({ ok: false, error: { code: 'stale-projection' } })
  })

  it('does not accept a forged view object at the evidence reader', async () => {
    const { store, request } = setup()
    const view = value(await store.openView(request))
    expect(await store.evidenceReader.readSources({ ...view }, []))
      .toMatchObject({ ok: false, error: { code: 'view-closed' } })
  })

  it('rejects a mismatched manifest and malformed query time or budget', async () => {
    const { store, request } = setup()
    expect(await store.openView({ ...request, expectedManifestId: 'wrong' })).toMatchObject({ ok: false, error: { code: 'version-mismatch' } })
    expect((await store.openView({ ...request, temporal: { ...request.temporal, knownAt: Number.NaN } })).ok).toBe(false)
    expect((await store.openView({ ...request, budget: { ...request.budget, maxNodes: -1 } })).ok).toBe(false)
  })

  it('cannot mutate stored data or policy through inputs or returned records', async () => {
    const { store, request, data } = setup()
    const view = value(await store.openView(request))
    Object.assign(data.bundle.claims[0]!, { modality: 'hypothetical' })
    Object.assign(view.context.temporal, { knownAt: 0 })
    Object.assign(view.manifest, { state: 'failed' })
    const first = value(await view.resolveClaims([data.bundle.claims[0]!.ref]))[0]!
    Object.assign(first, { modality: 'hypothetical' })
    expect(value(await view.resolveClaims([first.ref]))[0]!.modality).toBe('asserted')
    const edge = value(await view.neighbors(query())).items[0]!
    Object.assign(edge.from, { id: 'tampered' })
    expect(value(await view.neighbors(query())).items[0]!.from.id).toBe('C1')
  })

  it('paginates deterministically and binds cursors to the view and query', async () => {
    const data = createFeverAbsenceFixture()
    addSecondRelation(data)
    const { store, request } = setup(data)
    const view = value(await store.openView(request))
    const first = value(await view.neighbors(query({ limit: 1 })))
    expect(first.completion).toBe('more')
    const cursor = first.nextCursor!
    const second = value(await view.neighbors(query({ limit: 1, cursor })))
    expect(second.completion).toBe('complete')
    expect(second.items[0]!.id).not.toBe(first.items[0]!.id)
    expect((await view.neighbors(query({ direction: 'both', cursor }))).ok).toBe(false)
    const other = value(await store.openView(request))
    expect((await other.neighbors(query({ cursor }))).ok).toBe(false)
  })

  it('advances past filtered edges under maxScanned without reporting false completion', async () => {
    const data = createFeverAbsenceFixture()
    addSecondRelation(data)
    Object.assign(data.bundle.relations[0]!, { assertion: 'hypothesis' })
    const { store, request } = setup(data)
    const view = value(await store.openView(request))
    const first = value(await view.neighbors(query({ maxScanned: 1 })))
    expect(first).toMatchObject({ items: [], scanned: 1, completion: 'more' })
    const second = value(await view.neighbors(query({ cursor: first.nextCursor })))
    expect(second.items).toHaveLength(1)
    expect(second.completion).toBe('complete')
  })

  it('charges edge scans cumulatively across pages and retries', async () => {
    const data = createFeverAbsenceFixture()
    addSecondRelation(data)
    const { store, request } = setup(data)
    const view = value(await store.openView({ ...request, budget: { ...request.budget, maxEdges: 1 } }))
    expect(value(await view.neighbors(query()))).toMatchObject({ scanned: 1, completion: 'budget-exhausted' })
    expect(value(await view.neighbors(query()))).toMatchObject({ scanned: 0, items: [], completion: 'budget-exhausted' })
  })

  it('enforces node budgets and a zero-hop budget', async () => {
    const { store, request } = setup()
    const small = value(await store.openView({ ...request, budget: { ...request.budget, maxNodes: 1 } }))
    expect(value(await small.neighbors(query()))).toMatchObject({ items: [], completion: 'budget-exhausted' })
    const noNodes = value(await store.openView({ ...request, budget: { ...request.budget, maxNodes: 0 } }))
    expect(value(await noNodes.neighbors(query()))).toMatchObject({ items: [], scanned: 0, completion: 'budget-exhausted' })
    const noHops = value(await store.openView({ ...request, budget: { ...request.budget, maxHops: 0 } }))
    expect(value(await noHops.neighbors(query()))).toMatchObject({ items: [], completion: 'budget-exhausted' })
  })

  it('reads a shared source through a visited owner without charging an unrelated node', async () => {
    const { store, request, data } = setup()
    const view = value(await store.openView({ ...request, budget: { ...request.budget, maxNodes: 1 } }))
    const seed = data.bundle.claims[1]!
    value(await view.resolveClaims([seed.ref]))
    expect((await store.evidenceReader.readSources(view, [seed.evidence[0].source])).ok).toBe(true)
    expect(await view.resolveClaims([data.bundle.claims[0]!.ref]))
      .toMatchObject({ ok: false, error: { code: 'budget-exhausted' } })
  })

  it('counts evidence across source and fact outputs, returning no partial batch on exhaustion', async () => {
    const { store, request, data } = setup()
    const view = value(await store.openView({ ...request, budget: { ...request.budget, maxEvidenceTokens: 1 } }))
    expect((await store.evidenceReader.readSources(view, [data.bundle.claims[0]!.evidence[0].source])).ok).toBe(true)
    expect(await store.evidenceReader.resolveFactVersions(view, [data.bundle.claims[0]!.fact]))
      .toMatchObject({ ok: false, error: { code: 'budget-exhausted' } })
  })

  it('enforces elapsed time using an injected clock', async () => {
    let time = 0
    const { store, request } = setup(undefined, { clock: () => time })
    const view = value(await store.openView(request))
    time = request.budget.maxElapsedMs
    expect(await view.neighbors(query())).toMatchObject({ ok: false, error: { code: 'budget-exhausted' } })
  })

  it('advertises exact-polarity lookup while keeping rule execution unsupported', async () => {
    const { store, request, data } = setup()
    const view = value(await store.openView(request))
    expect(await view.resolveRules([])).toMatchObject({ ok: false, error: { code: 'unsupported-logic' } })
    expect(await view.matchRuleBody({ rule: { kind: 'rule', id: 'rule', version: 1 }, bindings: {}, limit: 1, maxScanned: 1 }))
      .toMatchObject({ ok: false, error: { code: 'unsupported-logic' } })
    expect(view.conflictPolicy).toBe('exact-opposite-polarity-v1')
    expect(value(await view.findConflicts(data.bundle.claims[0]!.ref, { limit: 1, maxScanned: 1 })))
      .toMatchObject({ items: [], completion: 'complete' })
  })

  it('refuses inconsistent input or overlapping historical relation versions', () => {
    const invalid = createFeverAbsenceFixture()
    Object.assign(invalid.edges[0]!, { kind: 'before' })
    expect(() => setup(invalid)).toThrow('Invalid graph relation data')
    const overlapping = createFeverAbsenceFixture(true)
    Object.assign(overlapping.bundle.relations[0]!, { transactionTime: { recordedAt: FEVER_ABSENCE_RECORDED_AT, closedAt: null } })
    expect(() => setup(overlapping)).toThrow('Overlapping or unordered')
  })
})
