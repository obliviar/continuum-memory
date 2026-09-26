import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { MEMORY_GRAPH_PROTOCOL_VERSION } from '@continuum-memory/contracts'
import type { GraphResult } from '@continuum-memory/contracts'
import type {  GraphProjectionManifest } from '../domain/types'
import type { GraphRecallRelationKind as GraphRelationKind } from '../domain/recall-types'
import type { GraphRelationValidationInput } from '../domain/validation'
import { createFeverAbsenceFixture, FEVER_ABSENCE_DAY, FEVER_ABSENCE_RECORDED_AT, FEVER_ABSENCE_REVOKED_AT } from '../fixtures/fever-absence'
import type { GraphRecallReadView as GraphReadView, GraphRecallEvidenceReader as GraphEvidenceReader } from '../ports/graph-recall-ports'
import { createInMemoryGraph } from '../repository/in-memory-graph'
import { createOneHopGraphRecall } from './one-hop-recall'
import type { OneHopGraphRecallRequest } from './one-hop-recall'

function value<T>(result: GraphResult<T>): T {
  if (!result.ok) throw new Error(result.error.code)
  return result.value
}

function setup(data = createFeverAbsenceFixture(), options: {
  onOpen?: (view: GraphReadView) => void
  wrapEvidence?: (reader: GraphEvidenceReader) => GraphEvidenceReader
  clock?: () => number
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
    countTokens: () => 1, clock: options.clock ?? (() => 0) }) // Synthetic budget units, not a production tokenizer.
  let opened: GraphReadView | undefined
  const recall = createOneHopGraphRecall({
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
    evidenceReader: options.wrapEvidence?.(store.evidenceReader) ?? store.evidenceReader,
  })
  const request: OneHopGraphRecallRequest = {
    recallId: 'recall-1', seed: { kind: 'claim', id: 'C2', version: 1 }, direction: 'in', kinds: ['causal'],
    view: {
      access: grant, expectedManifestId: 'm1', policyVersion: 'direct-v1',
      temporal: { valid: { kind: 'at', at: FEVER_ABSENCE_DAY + 1 }, knownAt: FEVER_ABSENCE_RECORDED_AT + 1 },
      budget: { maxSeeds: 1, maxNodes: 20, maxEdges: 100, maxHops: 1, maxRuleBindings: 0, maxProofSteps: 0,
        maxElapsedMs: 1000, maxEvidenceTokens: 100 },
    },
  }
  return { recall: recall.recall, request, store, data, opened: () => opened! }
}

function addRelation(data: GraphRelationValidationInput, id: string, kind: GraphRelationKind = 'causal') {
  const relation = structuredClone(data.bundle.relations[0]!)
  Object.assign(relation, { ref: { kind: 'relation', id, version: 1 }, kind })
  Object.assign(data.bundle, { relations: [...data.bundle.relations, relation] })
  Object.assign(data, { edges: [...data.edges, { id: `edge-${id}`, layer: 'semantic', kind,
    from: relation.from, to: relation.to, relationRef: relation.ref }] })
  return relation
}

describe('single-seed one-hop graph recall', () => {
  it('returns exact facts, directed relation, source span and honest completeness in one call', async () => {
    const s = setup()
    const result = value(await s.recall(s.request))
    expect(result.claims.map(item => item.record.ref.id)).toEqual(['C2', 'C1'])
    expect(result.claims[1]!.canonicalText).toContain('发烧')
    expect(result.claims[0]!.record.polarity).toBe('negative')
    expect(result.groups).toEqual([{ relation: { kind: 'relation', id: 'R1', version: 1 },
      from: { kind: 'claim', id: 'C1', version: 1 }, to: s.request.seed }])
    expect(result.sources).toHaveLength(1)
    expect(result.sources[0]!.content).toContain('因为发烧')
    expect(result).toMatchObject({ completeness: 'complete-within-declared-scope', stopReason: 'neighbors-exhausted',
      scannedEdges: 1, conflictCheck: 'not-performed', interpretation: 'source-asserted-relations' })
    expect(s.opened().close).toHaveBeenCalledOnce()
    expect((await s.opened().resolveClaims([])).ok).toBe(false)
  })

  it('does not reverse causation or equate temporal edges with causal edges', async () => {
    const data = createFeverAbsenceFixture()
    addRelation(data, 'R2', 'before')
    const s = setup(data)
    const none = value(await s.recall({ ...s.request, direction: 'out' }))
    expect(none.relations).toEqual([])
    const temporal = value(await s.recall({ ...s.request, kinds: ['before'] }))
    expect(temporal.relations.map(item => item.kind)).toEqual(['before'])
    const forward = value(await s.recall({ ...s.request, seed: data.bundle.claims[0]!.ref, direction: 'out' }))
    expect(forward.groups[0]!.from.id).toBe('C1')
    expect(forward.groups[0]!.to.id).toBe('C2')
  })

  it('does not follow a second edge even when the caller allows more hops', async () => {
    const data = createFeverAbsenceFixture()
    const claim = structuredClone(data.bundle.claims[0]!)
    Object.assign(claim, { ref: { kind: 'claim', id: 'C4', version: 1 }, fact: { kind: 'v4-fact', id: 'F4', version: 1 } })
    Object.assign(data.bundle, { claims: [...data.bundle.claims, claim] })
    Object.assign(data, { factVersions: [...data.factVersions, { ref: claim.fact, scope: claim.scope, canonicalText: '测试用的上游事件。' }] })
    const relation = addRelation(data, 'R2')
    Object.assign(relation, { from: claim.ref, to: data.bundle.claims[0]!.ref })
    Object.assign(data.edges[1]!, { from: relation.from, to: relation.to })
    const s = setup(data)
    const result = value(await s.recall({ ...s.request, view: { ...s.request.view, budget: { ...s.request.view.budget, maxHops: 5 } } }))
    expect(result.claims.map(item => item.record.ref.id)).toEqual(['C2', 'C1'])
    expect(result.relations.map(item => item.ref.id)).toEqual(['R1'])
    expect(result.searchScope.maxHops).toBe(1)
    expect(s.opened().neighbors).toHaveBeenCalledTimes(1)
  })

  it('deduplicates shared endpoints, facts and sources across relation pages', async () => {
    const data = createFeverAbsenceFixture()
    addRelation(data, 'R2')
    const s = setup(data)
    // C2 text + E1 source + C1 text = 3 units; reading E1 twice would fail.
    const result = value(await s.recall({ ...s.request, kinds: ['causal', 'causal'],
      view: { ...s.request.view, budget: { ...s.request.view.budget, maxEvidenceTokens: 3 } } }))
    expect(result.claims).toHaveLength(2)
    expect(result.relations).toHaveLength(2)
    expect(result.sources).toHaveLength(1)
    expect(result.searchScope.kinds).toEqual(['causal'])
    expect(result.scannedEdges).toBe(2)
    expect(s.opened().neighbors).toHaveBeenCalledTimes(2)
  })

  it('continues after a fully filtered page, rather than claiming no results', async () => {
    const data = createFeverAbsenceFixture()
    Object.assign(data.bundle.relations[0]!, { assertion: 'hypothesis' })
    for (let i = 0; i < 64; i++) addRelation(data, `filtered-${i}`)
    const eligible = addRelation(data, 'zz-eligible')
    Object.assign(eligible, { assertion: 'explicit-claim' })
    const s = setup(data)
    const result = value(await s.recall(s.request))
    expect(result.relations.map(item => item.ref.id)).toEqual(['zz-eligible'])
    expect(result.scannedEdges).toBe(66)
    expect(result.completeness).toBe('complete-within-declared-scope')
    expect(s.opened().neighbors).toHaveBeenCalledTimes(2)
  })

  it('returns complete groups but labels a scan-budget cutoff incomplete', async () => {
    const data = createFeverAbsenceFixture()
    addRelation(data, 'R2')
    const s = setup(data)
    const result = value(await s.recall({ ...s.request, view: { ...s.request.view, budget: { ...s.request.view.budget, maxEdges: 1 } } }))
    expect(result).toMatchObject({ completeness: 'incomplete', stopReason: 'budget-exhausted', scannedEdges: 1 })
    expect(result.groups).toHaveLength(1)
    expect(result.claims).toHaveLength(2)
  })

  it.each([{ maxNodes: 1 }, { maxHops: 0 }, { maxEvidenceTokens: 2 }, { maxEdges: 0 }])(
    'keeps the seed but no unsupported partial relation on budget cutoff %j', async (budget) => {
      const s = setup()
      const result = value(await s.recall({ ...s.request, view: { ...s.request.view, budget: { ...s.request.view.budget, ...budget } } }))
      expect(result.completeness).toBe('incomplete')
      expect(result.claims.map(item => item.record.ref.id)).toEqual(['C2'])
      expect(result.relations).toEqual([])
      expect(result.groups).toEqual([])
      expect(result.sources).toHaveLength(1)
    })

  it('does not publish staged neighbor text if the relation source cannot fit', async () => {
    const data = createFeverAbsenceFixture()
    const text = '测试专用：新的关系证据。'
    const contentHash = createHash('sha256').update(text).digest('hex')
    const source = { episodeId: 'E4', contentHash, locator: { kind: 'whole-content' as const } }
    Object.assign(data, { sources: [...data.sources, { episodeId: 'E4', contentHash, content: text, scope: data.bundle.scope }] })
    Object.assign(data.bundle.relations[0]!, { evidence: [{ source, role: 'supports' }] })
    const s = setup(data)
    const result = value(await s.recall({ ...s.request, view: { ...s.request.view, budget: { ...s.request.view.budget, maxEvidenceTokens: 3 } } }))
    expect(result.completeness).toBe('incomplete')
    expect(result.claims.map(item => item.record.ref.id)).toEqual(['C2'])
    expect(result.sources.map(item => item.ref.episodeId)).toEqual(['E1'])
    expect(result.groups).toEqual([])
  })

  it.each([{ maxSeeds: 0 }, { maxNodes: 0 }, { maxEvidenceTokens: 0 }])('fails when the seed itself cannot be read: %j', async (budget) => {
    const s = setup()
    expect(await s.recall({ ...s.request, view: { ...s.request.view, budget: { ...s.request.view.budget, ...budget } } }))
      .toMatchObject({ ok: false, error: { code: 'budget-exhausted' } })
    expect(s.opened().close).toHaveBeenCalledOnce()
  })

  it('respects knownAt and does not resurrect revoked historical relations', async () => {
    const s = setup(createFeverAbsenceFixture(true))
    expect(value(await s.recall(s.request)).relations).toHaveLength(1)
    const after = value(await s.recall({ ...s.request, view: { ...s.request.view,
      temporal: { ...s.request.view.temporal, knownAt: FEVER_ABSENCE_REVOKED_AT } } }))
    expect(after.relations).toHaveLength(0)
    expect(after.completeness).toBe('complete-within-declared-scope')
  })

  it('rejects a missing seed version and closes the opened view', async () => {
    const s = setup()
    expect(await s.recall({ ...s.request, seed: { ...s.request.seed, version: 99 } }))
      .toMatchObject({ ok: false, error: { code: 'source-unavailable' } })
    expect(s.opened().close).toHaveBeenCalledOnce()
  })

  it('rechecks earlier cached evidence before returning it', async () => {
    const s = setup(undefined, { wrapEvidence: reader => ({ ...reader, async readSources(view, refs) {
      const result = await reader.readSources(view, refs)
      s.store.revokeSource('E1')
      return result
    } }) })
    // No expansion: the final check must still protect the cached seed text.
    expect(await s.recall({ ...s.request, view: { ...s.request.view, budget: { ...s.request.view.budget, maxHops: 0 } } }))
      .toMatchObject({ ok: false, error: { code: 'source-unavailable' } })
    expect(s.opened().close).toHaveBeenCalledOnce()
  })

  it('does not return cached text if elapsed time expires during evidence reading', async () => {
    let now = 0
    const s = setup(undefined, { clock: () => now, wrapEvidence: reader => ({ ...reader, async readSources(view, refs) {
      const result = await reader.readSources(view, refs)
      now = 1000
      return result
    } }) })
    expect(await s.recall(s.request)).toMatchObject({ ok: false, error: { code: 'budget-exhausted' } })
    expect(s.opened().close).toHaveBeenCalledOnce()
  })

  it('rejects a mismatched edge and exact relation record', async () => {
    const s = setup(undefined, { onOpen: view => {
      const read = view.resolveRelations
      vi.spyOn(view, 'resolveRelations').mockImplementation(async refs => {
        const result = await read(refs)
        if (result.ok && result.value[0]) Object.assign(result.value[0], { kind: 'before' })
        return result
      })
    } })
    expect(await s.recall(s.request)).toMatchObject({ ok: false, error: { code: 'version-mismatch' } })
  })

  it('does not accept shortened evidence batches from another adapter', async () => {
    const s = setup(undefined, { wrapEvidence: reader => ({ ...reader, async readSources() { return { ok: true, value: [] } } }) })
    expect(await s.recall(s.request)).toMatchObject({ ok: false, error: { code: 'source-unavailable' } })
    expect(s.opened().close).toHaveBeenCalledOnce()
  })

  it('rejects non-progressing pagination instead of looping', async () => {
    const s = setup(undefined, { onOpen: view => {
      vi.mocked(view.neighbors).mockResolvedValue({ ok: true, value: { items: [], scanned: 0, completion: 'more', nextCursor: 'loop' } })
    } })
    expect(await s.recall(s.request)).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
    expect(s.opened().neighbors).toHaveBeenCalledOnce()
  })

  it('closes after adapter exceptions and does not expose raw error details', async () => {
    const s = setup(undefined, { onOpen: view => {
      vi.mocked(view.neighbors).mockRejectedValue(new Error('private adapter internals'))
    } })
    expect(await s.recall(s.request)).toEqual({ ok: false, error: { code: 'not-ready', message: 'One-hop graph reader failed' } })
    expect(s.opened().close).toHaveBeenCalledOnce()
  })

  it('rejects invalid recall requests before opening a view', async () => {
    const s = setup()
    expect(await s.recall({ ...s.request, kinds: [] })).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
    expect(s.opened()).toBeUndefined()
  })
})
