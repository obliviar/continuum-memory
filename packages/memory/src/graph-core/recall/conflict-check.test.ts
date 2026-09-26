import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { MEMORY_GRAPH_PROTOCOL_VERSION } from '@continuum-memory/contracts'
import type { GraphResult } from '@continuum-memory/contracts'
import type {  GraphProjectionManifest } from '../domain/types'
import type { GraphRecallRelationKind as GraphRelationKind } from '../domain/recall-types'
import type { GraphRelationValidationInput } from '../domain/validation'
import { createFeverAbsenceFixture, FEVER_ABSENCE_DAY, FEVER_ABSENCE_RECORDED_AT } from '../fixtures/fever-absence'
import type { GraphRecallReadView as GraphReadView, GraphRecallEvidenceReader as GraphEvidenceReader } from '../ports/graph-recall-ports'
import { areOppositeClaims, claimConflictKey } from '../domain/claim-conflicts'
import { createInMemoryGraph } from '../repository/in-memory-graph'
import { createBoundedGraphRecall } from './bounded-graph-recall'
import type { GraphTraversalRecallRequest } from './bounded-graph-recall'

function value<T>(result: GraphResult<T>): T {
  if (!result.ok) throw new Error(result.error.code)
  return result.value
}

function setup(data = createFeverAbsenceFixture(), options: {
  onOpen?: (view: GraphReadView) => void
  wrapEvidence?: (reader: GraphEvidenceReader) => GraphEvidenceReader
  clock?: () => number
  maxConflictScanned?: number
} = {}) {
  const grant = {
    accessContextId: 'test', authorizationVersion: 'v1', scope: data.bundle.scope,
    sharePolicies: ['allow-remote' as const], sensitivities: ['normal' as const],
  }
  const manifest: GraphProjectionManifest = {
    protocolVersion: MEMORY_GRAPH_PROTOCOL_VERSION, schemaVersion: 1, manifestId: 'm1',
    sourceBundleId: data.bundle.bundleId, scope: data.bundle.scope, sourceRevisions: data.bundle.revisions,
    semanticFingerprint: createHash('sha256').update(JSON.stringify(data.bundle)).digest('hex'),
    builderVersion: 'test', navigationRevision: 0, createdAt: FEVER_ABSENCE_RECORDED_AT, state: 'ready',
  }
  const store = createInMemoryGraph({ data, manifest, resolveAccess: () => grant,
    maxConflictScanned: options.maxConflictScanned,
    countTokens: () => 1, clock: options.clock ?? (() => 0) }) // Synthetic budget units, not a production tokenizer.
  let opened: GraphReadView | undefined
  const recall = createBoundedGraphRecall({
    readPort: { async openView(request) {
      const result = await store.openView(request)
      if (result.ok) {
        opened = result.value
        vi.spyOn(opened, 'close')
        vi.spyOn(opened, 'neighbors')
        options.onOpen?.(opened)
      }
      return result
    } },
    seedPort: store.seedPort,
    evidenceReader: options.wrapEvidence?.(store.evidenceReader) ?? store.evidenceReader,
  })
  const request: GraphTraversalRecallRequest = {
    recallId: 'recall-1', seed: { kind: 'claim', id: 'C2', version: 1 }, direction: 'in', kinds: ['causal'],
    view: {
      access: grant, expectedManifestId: 'm1', policyVersion: 'direct-v1',
      temporal: { valid: { kind: 'at', at: FEVER_ABSENCE_DAY + 1 }, knownAt: FEVER_ABSENCE_RECORDED_AT + 1 },
      budget: { maxSeeds: 1, maxNodes: 20, maxEdges: 100, maxHops: 3, maxRuleBindings: 0, maxProofSteps: 0,
        maxElapsedMs: 1000, maxEvidenceTokens: 100 },
    },
  }
  return { recall: recall.recall, recallQuery: recall.recallQuery, request, store, data, opened: () => opened! }
}

function addRelation(data: GraphRelationValidationInput, id: string, kind: GraphRelationKind = 'causal') {
  const relation = structuredClone(data.bundle.relations[0]!)
  Object.assign(relation, { ref: { kind: 'relation', id, version: 1 }, kind })
  Object.assign(data.bundle, { relations: [...data.bundle.relations, relation] })
  Object.assign(data, { edges: [...data.edges, { id: `edge-${id}`, layer: 'semantic', kind,
    from: relation.from, to: relation.to, relationRef: relation.ref }] })
  return relation
}

// Synthetic graph topology tests; these cloned statements are not empirical causal evidence.
function addClaim(data: GraphRelationValidationInput, id: string, negative = false) {
  const claim = structuredClone(data.bundle.claims[negative ? 1 : 0]!)
  Object.assign(claim, { ref: { kind: 'claim', id, version: 1 }, fact: { kind: 'v4-fact', id: `fact-${id}`, version: 1 } })
  Object.assign(data.bundle, { claims: [...data.bundle.claims, claim] })
  Object.assign(data, { factVersions: [...data.factVersions, { ref: claim.fact, scope: claim.scope,
    canonicalText: negative ? data.factVersions[1]!.canonicalText : `测试上游事件 ${id}` }] })
  return claim
}
function link(data: GraphRelationValidationInput, id: string, from: string, to: string, kind: GraphRelationKind = 'causal') {
  const relation = addRelation(data, id, kind)
  Object.assign(relation, { from: data.bundle.claims.find(c => c.ref.id === from)!.ref,
    to: data.bundle.claims.find(c => c.ref.id === to)!.ref })
  Object.assign(data.edges[data.edges.length - 1]!, { from: relation.from, to: relation.to })
  return relation
}
function chain() {
  const data = createFeverAbsenceFixture()
  addClaim(data, 'C4')
  link(data, 'R2', 'C4', 'C1')
  return data
}
function withBudget(request: GraphTraversalRecallRequest, budget: Partial<GraphTraversalRecallRequest['view']['budget']>) {
  return { ...request, view: { ...request.view, budget: { ...request.view.budget, ...budget } } }
}
function opposite(data: GraphRelationValidationInput, targetId = 'C2', id = 'opposite') {
  const target = data.bundle.claims.find(c => c.ref.id === targetId)!
  const claim = structuredClone(target)
  const content = `测试来源 ${id}：对 ${targetId} 的相反断言。`
  const contentHash = createHash('sha256').update(content).digest('hex')
  const source = { episodeId: `source-${id}`, contentHash, locator: { kind: 'whole-content' as const } }
  Object.assign(claim, { ref: { kind: 'claim', id, version: 1 }, fact: { kind: 'v4-fact', id: `fact-${id}`, version: 1 },
    polarity: target.polarity === 'positive' ? 'negative' : 'positive',
    evidence: [{ source, role: 'supports', strength: 'direct' }], provenance: { ...claim.provenance, sources: [source] } })
  Object.assign(data.bundle, { claims: [...data.bundle.claims, claim] })
  Object.assign(data, { sources: [...data.sources, { episodeId: source.episodeId, contentHash, content, scope: claim.scope }],
    factVersions: [...data.factVersions, { ref: claim.fact, scope: claim.scope, canonicalText: content }] })
  return claim
}

describe('exact opposite-polarity identity and valid time', () => {
  it('canonicalizes argument order but preserves entity versions and literal types', () => {
    const data = createFeverAbsenceFixture()
    const other = opposite(data)
    const target = data.bundle.claims[1]!
    Object.assign(other.atom, { args: Object.fromEntries(Object.entries(other.atom.args).reverse()) })
    expect(claimConflictKey(target)).toBe(claimConflictKey(other))
    Object.assign(other.atom, { args: { ...other.atom.args, day: { kind: 'string', value: '2026-09-20' } } })
    expect(claimConflictKey(target)).not.toBe(claimConflictKey(other))
  })

  it.each(['entity', 'context', 'scope', 'predicate', 'argument', 'polarity', 'condition', 'modality'])(
    'does not equate a changed %s with a proven opposite', changed => {
      const data = createFeverAbsenceFixture()
      const other = opposite(data)
      const target = data.bundle.claims[1]!
      if (changed === 'entity') Object.assign(other.atom, { args: { ...other.atom.args, person: { kind: 'entity', ref: { kind: 'entity', id: 'someone-else', version: 1 } } } })
      if (changed === 'context') Object.assign(other.context, { version: 2 })
      if (changed === 'scope') Object.assign(other.scope, { ownerId: 'someone-else' })
      if (changed === 'predicate') Object.assign(other.atom, { predicate: 'another-predicate' })
      if (changed === 'argument') Object.assign(other.atom, { args: { ...other.atom.args, extra: { kind: 'number', value: 1, unit: 'kg' } } })
      if (changed === 'polarity') Object.assign(other, { polarity: target.polarity })
      if (changed === 'condition') Object.assign(other, { condition: { kind: 'unsupported', text: 'if', reason: 'test' } })
      if (changed === 'modality') Object.assign(other, { modality: 'inferred' })
      expect(areOppositeClaims(target, other, { valid: { kind: 'at', at: FEVER_ABSENCE_DAY + 1 }, knownAt: FEVER_ABSENCE_RECORDED_AT })).toBe(false)
    })

  it('requires a common instant inside the query, not just two independent overlaps with a broad window', () => {
    const data = createFeverAbsenceFixture()
    const other = opposite(data)
    const target = data.bundle.claims[1]!
    Object.assign(target, { validTime: { kind: 'interval', from: 0, to: 10 } })
    Object.assign(other, { validTime: { kind: 'interval', from: 10, to: 20 } })
    const temporal = { valid: { kind: 'overlap' as const, from: 0, to: 20 }, knownAt: FEVER_ABSENCE_RECORDED_AT }
    expect(areOppositeClaims(target, other, temporal)).toBe(false)
    Object.assign(other, { validTime: { kind: 'interval', from: 9, to: 20 } })
    expect(areOppositeClaims(target, other, temporal)).toBe(true)
    expect(areOppositeClaims(target, other, { ...temporal, valid: { kind: 'overlap', from: 10, to: 20 } })).toBe(false)
    expect(areOppositeClaims(target, other, { ...temporal, valid: { kind: 'at', at: 10 } })).toBe(false)
  })
})

describe('conflict reader pagination, budgets and eligibility', () => {
  it('continues after an empty page and binds cursors to the exact target and view', async () => {
    const data = createFeverAbsenceFixture()
    const other = opposite(data)
    const s = setup(data)
    const view = value(await s.store.openView(s.request.view))
    const page = value(await view.findConflicts(s.request.seed, { limit: 1, maxScanned: 1 }))
    expect(page).toMatchObject({ items: [], scanned: 1, completion: 'more' })
    expect(value(await view.findConflicts(s.request.seed, { limit: 1, maxScanned: 1, cursor: page.nextCursor })).items[0]!.ref).toEqual(other.ref)
    expect(await view.findConflicts(data.bundle.claims[0]!.ref, { limit: 1, maxScanned: 1, cursor: page.nextCursor }))
      .toMatchObject({ ok: false, error: { code: 'invalid-request' } })
    const otherView = value(await s.store.openView(s.request.view))
    expect(await otherView.findConflicts(s.request.seed, { limit: 1, maxScanned: 1, cursor: page.nextCursor }))
      .toMatchObject({ ok: false, error: { code: 'invalid-request' } })
  })

  it('accumulates conflict scans across different targets instead of resetting on each lookup', async () => {
    const data = createFeverAbsenceFixture()
    opposite(data)
    const s = setup(data, { maxConflictScanned: 2 })
    const view = value(await s.store.openView(s.request.view))
    expect(value(await view.findConflicts(s.request.seed, { limit: 10, maxScanned: 64 })).completion).toBe('complete')
    expect(value(await view.findConflicts(data.bundle.claims[0]!.ref, { limit: 10, maxScanned: 64 })))
      .toMatchObject({ items: [], scanned: 0, completion: 'budget-exhausted' })
  })

  it.each(['private', 'deleted', 'future', 'unknown-time', 'unreviewed'])(
    'does not expose ineligible opposing evidence: %s', async reason => {
      const data = createFeverAbsenceFixture()
      const other = opposite(data)
      if (reason === 'private') Object.assign(other, { sharePolicy: 'local-only' })
      if (reason === 'future') Object.assign(other.transactionTime, { recordedAt: FEVER_ABSENCE_RECORDED_AT + 10 })
      if (reason === 'unknown-time') Object.assign(other, { validTime: { kind: 'unknown' } })
      if (reason === 'unreviewed') Object.assign(other, { review: { status: 'candidate' } })
      const s = setup(data)
      if (reason === 'deleted') s.store.revokeSource('source-opposite')
      const result = value(await s.recall(s.request))
      expect(result.conflictCheck).toBe('complete-within-policy')
      expect(result.conflictAudit.pairs).toEqual([])
      expect(result.claims.some(c => c.record.ref.id === other.ref.id)).toBe(false)
      expect(result.sources.some(source => source.ref.episodeId === 'source-opposite')).toBe(false)
    })

  it('keeps private view context isolated and refuses reads after closing', async () => {
    const s = setup()
    const view = value(await s.store.openView(s.request.view))
    // Private view state cannot be changed by mutating the detached public context.
    Object.assign(view.context.access, { authorizationVersion: 'forged' })
    expect(value(await view.findConflicts(s.request.seed, { limit: 1, maxScanned: 64 })).completion).toBe('complete')
    await view.close()
    expect(await view.findConflicts(s.request.seed, { limit: 1, maxScanned: 64 }))
      .toMatchObject({ ok: false, error: { code: 'view-closed' } })
  })
})

describe('bounded recall conflict evidence and alternatives', () => {
  it('deduplicates a conflict pair when both endpoints were already traversed', async () => {
    const data = createFeverAbsenceFixture()
    opposite(data)
    link(data, 'R2', 'opposite', 'C2')
    const s = setup(data)
    const result = value(await s.recall(s.request))
    expect(result.conflictCheck).toBe('complete-within-policy')
    expect(result.conflictAudit.pairs).toHaveLength(1)
    expect(result.conflictAudit.targets.some(t => t.claim.id === 'opposite' && t.status === 'complete')).toBe(true)
  })

  it('treats duplicate structured cause statements as one candidate explanation', async () => {
    const data = createFeverAbsenceFixture()
    addClaim(data, 'C4') // same atom, sign, context and valid interval as C1
    link(data, 'R2', 'C4', 'C2')
    const s = setup(data)
    const result = value(await s.recall(s.request))
    const check = result.causalAlternatives.find(c => c.target.id === 'C2')!
    expect(check.hasMultipleCauses).toBe(false)
    expect(check.causes).toHaveLength(1)
    expect(check.causes[0]!.claims.map(c => c.id).sort()).toEqual(['C1', 'C4'])
  })

  it('rejects conflict reads after the trusted host changes the authorization revision', async () => {
    const s = setup()
    const view = value(await s.store.openView(s.request.view))
    // This fixture intentionally shares the host grant object with the input access object.
    Object.assign(s.request.view.access, { authorizationVersion: 'revoked' })
    expect(await view.findConflicts(s.request.seed, { limit: 1, maxScanned: 64 }))
      .toMatchObject({ ok: false, error: { code: 'scope-denied' } })
  })

  it('finds disconnected opposing evidence, retains both sides, and does not extend traversal paths with audit-only claims', async () => {
    const data = chain()
    const other = opposite(data)
    const s = setup(data)
    const result = value(await s.recall(s.request))
    expect(result.conflictCheck).toBe('complete-within-policy')
    expect(result.conflictAudit.pairs).toEqual([{ claim: s.request.seed, opposing: other.ref, kind: 'opposite-polarity' }])
    expect(result.claims.some(c => c.record.ref.id === other.ref.id)).toBe(true)
    expect(result.sources.some(source => source.ref.episodeId === 'source-opposite')).toBe(true)
    expect(result.paths.some(path => path.target.id === other.ref.id)).toBe(false)
    expect(result.conflictAudit.targets.map(t => t.claim.id)).toEqual(['C2', 'C1', 'C4'])
    expect(result.relations).toHaveLength(2)
    expect(s.opened().close).toHaveBeenCalledOnce()
  })

  it.each([{ maxNodes: 2 }, { maxEvidenceTokens: 3 }, { maxEvidenceTokens: 4 }])(
    'marks the audit incomplete without publishing a half-hydrated opposing claim: %j', async budget => {
      const data = createFeverAbsenceFixture()
      opposite(data)
      const s = setup(data)
      const result = value(await s.recall(withBudget(s.request, budget)))
      expect(result.completeness).toBe('complete-within-declared-scope') // traversal only
      expect(result.conflictCheck).toBe('incomplete')
      expect(result.conflictAudit.reason).toBe('budget-exhausted')
      expect(result.conflictAudit.pairs).toEqual([])
      expect(result.claims.map(c => c.record.ref.id)).toEqual(['C2', 'C1'])
      expect(result.conflictAudit.targets.map(t => t.status)).toEqual(['incomplete', 'not-started'])
    })

  it('reports scan truncation explicitly, not an absence of conflicts', async () => {
    const data = createFeverAbsenceFixture()
    opposite(data)
    const s = setup(data, { maxConflictScanned: 1 })
    const result = value(await s.recall(s.request))
    expect(result.conflictCheck).toBe('incomplete')
    expect(result.conflictAudit).toMatchObject({ reason: 'budget-exhausted', scanned: 1, pairs: [] })
  })

  it('reports unsupported policy separately from a completed empty search', async () => {
    const s = setup(undefined, { onOpen(view) { Object.assign(view, { conflictPolicy: undefined }) } })
    const result = value(await s.recall(s.request))
    expect(result.conflictCheck).toBe('unsupported')
    expect(result.conflictAudit.targets.every(t => t.status === 'not-started')).toBe(true)
  })

  it('rejects a reader that invents a conflict candidate', async () => {
    const s = setup(undefined, { onOpen(view) {
      vi.spyOn(view, 'findConflicts').mockResolvedValue({ ok: true, value: { items: [createFeverAbsenceFixture().bundle.claims[0]!], scanned: 1, completion: 'complete' } })
    } })
    expect(await s.recall(s.request)).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
    expect(s.opened().close).toHaveBeenCalledOnce()
  })

  it('bounds third-party pagination even when every page claims scan progress', async () => {
    let totalScanned = 0
    let calls = 0
    const s = setup(undefined, { onOpen(view) {
      vi.spyOn(view, 'findConflicts').mockImplementation(async (_ref, page) => {
        totalScanned += page.maxScanned
        return { ok: true, value: { items: [], scanned: page.maxScanned, completion: 'more', nextCursor: `page-${++calls}` } }
      })
    } })
    const result = value(await s.recall(s.request))
    expect(result.conflictCheck).toBe('incomplete')
    expect(result.conflictAudit.scanned).toBe(10000)
    expect(totalScanned).toBe(10000)
    expect(calls).toBe(157)
  })

  it('rejects conflict pagination that makes no progress', async () => {
    const s = setup(undefined, { onOpen(view) {
      vi.spyOn(view, 'findConflicts').mockResolvedValue({ ok: true, value: { items: [], scanned: 0, completion: 'more', nextCursor: 'same' } })
    } })
    expect(await s.recall(s.request)).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
  })

  it('fails closed when a newly hydrated opposing source is deleted before final validation', async () => {
    const data = createFeverAbsenceFixture()
    opposite(data)
    let calls = 0
    const s = setup(data, { onOpen(view) {
      const read = view.findConflicts.bind(view)
      vi.spyOn(view, 'findConflicts').mockImplementation(async (ref, page) => {
        const result = await read(ref, page)
        if (++calls === 2) s.store.revokeSource('source-opposite')
        return result
      })
    } })
    expect(await s.recall(s.request)).toMatchObject({ ok: false, error: { code: 'source-unavailable' } })
  })

  it('lists different causes together without labeling them mutually exclusive or counting duplicate support as another cause', async () => {
    const data = createFeverAbsenceFixture()
    const cause = addClaim(data, 'C4')
    Object.assign(cause.atom, { args: { ...cause.atom.args, symptom: { kind: 'string', value: 'headache' } } })
    link(data, 'R2', 'C4', 'C2', 'contributes-to')
    link(data, 'R3', 'C1', 'C2')
    const s = setup(data)
    const result = value(await s.recall({ ...s.request, kinds: ['causal', 'contributes-to'] }))
    const alternatives = result.causalAlternatives.find(check => check.target.id === 'C2')!
    expect(alternatives).toMatchObject({ hasMultipleCauses: true, coverage: 'complete-within-declared-scope', interpretation: 'candidates-may-coexist' })
    expect(alternatives.causes).toHaveLength(2)
    expect(alternatives.causes.find(c => c.claims[0]!.id === 'C1')!.relations).toHaveLength(2)
    expect(result.conflictAudit.pairs).toEqual([])
  })

  it('marks a budget-cut causal search incomplete and a depth-boundary target unchecked', async () => {
    const data = chain()
    addClaim(data, 'C5')
    link(data, 'R3', 'C5', 'C2')
    const s = setup(data)
    const partial = value(await s.recall(withBudget(s.request, { maxEdges: 1 })))
    expect(partial.causalAlternatives.find(check => check.target.id === 'C2')!.coverage).toBe('incomplete')
    const depth = value(await s.recall(withBudget(s.request, { maxHops: 1 })))
    expect(depth.causalAlternatives.find(check => check.target.id === 'C1')!.coverage).toBe('not-checked')
  })

  it('does not advertise outgoing or temporal traversal as a complete search for competing causes', async () => {
    const s = setup()
    const outgoing = value(await s.recall({ ...s.request, seed: s.data.bundle.claims[0]!.ref, direction: 'out' }))
    expect(outgoing.causalAlternatives.every(c => c.coverage === 'not-checked')).toBe(true)
    const temporal = value(await s.recall({ ...s.request, kinds: ['before'] }))
    expect(temporal.causalAlternatives.every(c => c.coverage === 'not-checked' && c.causes.length === 0)).toBe(true)
  })
})
