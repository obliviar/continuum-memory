import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { GraphResult, GraphSourceRef } from '@continuum-memory/contracts'
import type { GraphProjectionSnapshot } from '../domain/types'
import type { GraphRelationRecord, GraphRelationSnapshot, GraphRelationKind } from '../domain/relation-types'
import type { GraphReadView, GraphReadPort, GraphEvidenceReader } from '../ports/graph-ports'
import type { GraphRecallReadView } from '../ports/graph-recall-ports'
import { createFeverAbsenceFixture, FEVER_ABSENCE_DAY, FEVER_ABSENCE_RECORDED_AT } from '../fixtures/fever-absence'
import { createInMemoryGraph } from '../repository/in-memory-graph'
import { createGraphRelationRepository } from '../repository/relation-repository'
import { createGraphRelationReadPort } from '../repository/relation-read-port'
import { createBoundedGraphRecall } from './bounded-graph-recall'
import type { GraphTraversalRecallRequest } from './bounded-graph-recall'
import { createL2GraphRecallAdapter } from './l2-recall-adapter'

function value<T>(result: GraphResult<T>): T { if (!result.ok) throw new Error(result.error.message); return result.value }
async function setup(options: { kind?: GraphRelationKind; polarity?: 'positive' | 'negative'; modality?: 'asserted' | 'hypothetical'; unknownTime?: boolean; chain?: boolean; extraSource?: boolean; fanout?: number } = {}) {
  const data = createFeverAbsenceFixture()
  if (options.chain) {
    const claim = structuredClone(data.bundle.claims[0]!)
    Object.assign(claim, { ref: { kind: 'claim', id: 'C4', version: 1 }, fact: { kind: 'v4-fact', id: 'F4', version: 1 } })
    Object.assign(data.bundle, { claims: [...data.bundle.claims, claim] })
    Object.assign(data, { factVersions: [...data.factVersions, { ref: claim.fact, scope: claim.scope, canonicalText: '测试上游事件' }] })
  }
  for (let i = 0; i < (options.fanout ?? 0); i++) {
    const claim = structuredClone(data.bundle.claims[0]!)
    Object.assign(claim, { ref: { kind: 'claim', id: `extra-${i}`, version: 1 }, fact: { kind: 'v4-fact', id: `extra-fact-${i}`, version: 1 } })
    Object.assign(data.bundle, { claims: [...data.bundle.claims, claim] })
    Object.assign(data, { factVersions: [...data.factVersions, { ref: claim.fact, scope: claim.scope, canonicalText: '测试独立原因' }] })
  }
  const access = { accessContextId: 'test', authorizationVersion: 'v1', scope: data.bundle.scope,
    sharePolicies: ['allow-remote' as const], sensitivities: ['normal' as const] }
  const { relations: _legacyRelations, revisions: _legacyRevisions, ...bundle } = data.bundle
  const revisions = { v4: 1, semantics: 1, predicates: 1, rules: 0, aliases: 0 }
  const core: GraphProjectionSnapshot = { semanticBundle: { ...bundle, revisions }, derivedClaims: [], proofs: [], edges: [], manifest: {
    protocolVersion: 'memory-graph/v1', schemaVersion: 1, manifestId: 'core-1', sourceBundleId: bundle.bundleId,
    scope: bundle.scope, sourceRevisions: revisions, semanticFingerprint: 'test', builderVersion: 'test', navigationRevision: 0,
    createdAt: FEVER_ABSENCE_RECORDED_AT, state: 'ready' } }
  const tombstones = new Set<string>()
  const store = createInMemoryGraph({ data, manifest: core.manifest, resolveAccess: () => access, countTokens: () => 1, clock: () => 0 })
  const mapping = new WeakMap<GraphReadView, GraphRecallReadView>()
  const live = new Set<string>()
  let lastCore: GraphReadView | undefined
  const coreReadPort: GraphReadPort = { async openView(request) {
    const original = value(await store.openView(request))
    const wrapped: GraphReadView = { ...original,
      // The actual L1 port must never publish the fixture's legacy L2 edges.
      neighbors: async () => ({ ok: true, value: { items: [], scanned: 0, completion: 'complete' } }),
      close: vi.fn(async () => { live.delete(wrapped.viewId); await original.close() }),
    }
    mapping.set(wrapped, original); live.add(wrapped.viewId); lastCore = wrapped
    return { ok: true, value: wrapped }
  } }
  const coreEvidenceReader: GraphEvidenceReader = {
    readSources: (view, refs) => store.evidenceReader.readSources(mapping.get(view)!, refs),
    resolveFactVersions: (view, refs) => store.evidenceReader.resolveFactVersions(mapping.get(view)!, refs),
  }
  const legacy = data.bundle.relations[0]!
  let evidenceSource = legacy.evidence[0]!.source
  if (options.extraSource) {
    const content = '这是独立的关系原文证据。'
    evidenceSource = { episodeId: 'relation-only', contentHash: createHash('sha256').update(content).digest('hex'), locator: { kind: 'whole-content' } }
    Object.assign(data, { sources: [...data.sources, { episodeId: evidenceSource.episodeId, contentHash: evidenceSource.contentHash, content, scope: bundle.scope }] })
  }
  const relation: GraphRelationRecord = {
    ref: legacy.ref, from: legacy.from, to: legacy.to, scope: legacy.scope,
    transactionTime: legacy.transactionTime, provenance: { ...legacy.provenance, sources: [evidenceSource] },
    review: legacy.review, sharePolicy: legacy.sharePolicy, sensitivity: legacy.sensitivity,
    kind: options.kind ?? 'causes', polarity: options.polarity ?? 'positive', modality: options.modality ?? 'asserted',
    context: legacy.context, validTime: options.unknownTime ? { kind: 'unknown' } : legacy.validTime,
    assertionBasis: 'source-explicit', nliObservationIds: [], evidence: [{ source: evidenceSource, role: 'supports' }],
  }
  const verify = async (refs: readonly GraphSourceRef[]): Promise<GraphResult<void>> => refs.some(ref => tombstones.has(ref.episodeId))
    ? { ok: false, error: { code: 'source-unavailable', message: 'Source deleted' } } : { ok: true, value: undefined }
  const repository = createGraphRelationRepository({ coreSnapshot: () => core, verifySources: verify, now: () => FEVER_ABSENCE_RECORDED_AT })
  const relations = [relation]
  if (options.chain) relations.push({ ...structuredClone(relation), ref: { kind: 'relation', id: 'R2', version: 1 },
    from: data.bundle.claims.find(c => c.ref.id === 'C4')!.ref, to: data.bundle.claims[0]!.ref })
  for (const claim of data.bundle.claims.filter(c => c.ref.id.startsWith('extra-'))) {
    relations.push({ ...structuredClone(relation), ref: { kind: 'relation', id: `relation-${claim.ref.id}`, version: 1 }, from: claim.ref })
  }
  const snapshot: GraphRelationSnapshot = { manifest: { ...repository.snapshot().manifest, manifestId: 'l2-1', relationRevision: 1 },
    relations, candidates: [], observations: [] }
  value(await repository.publish({ operationId: 'publish', expectedManifestId: repository.snapshot().manifest.manifestId, snapshot }))
  const relationReadPort = createGraphRelationReadPort({ repository, isCoreViewLive: async id => live.has(id), verifySources: verify })
  const readRelationSources = vi.fn(async (_view, refs: readonly GraphSourceRef[]) => {
    const checked = await verify(refs); if (!checked.ok) return checked
    return { ok: true as const, value: refs.map(ref => {
      const source = data.sources.find(s => s.episodeId === ref.episodeId && s.contentHash === ref.contentHash)!
      return { ref, scope: source.scope, content: ref.locator.kind === 'whole-content' ? source.content : source.content.slice(ref.locator.start, ref.locator.end) }
    }) }
  })
  const searchSeeds = vi.fn(async () => ({ ok: true as const, value: { items: [{ ref: data.bundle.claims[1]!.ref, relevance: 1, route: 'structured' as const }], scanned: 1, completion: 'complete' as const } }))
  const ports = createL2GraphRecallAdapter({ coreReadPort, coreEvidenceReader, relationReadPort, readRelationSources, countTokens: () => 1, searchSeeds })
  const service = createBoundedGraphRecall(ports)
  const request: GraphTraversalRecallRequest = { recallId: 'recall', seed: data.bundle.claims[1]!.ref, direction: 'in', kinds: [options.kind ?? 'causes'],
    view: { access, expectedManifestId: 'core-1', expectedRelationManifestId: 'l2-1', policyVersion: 'l2-direct',
      temporal: { valid: { kind: 'at', at: FEVER_ABSENCE_DAY + 1 }, knownAt: FEVER_ABSENCE_RECORDED_AT + 1 },
      budget: { maxSeeds: 3, maxNodes: 20, maxEdges: 100, maxHops: 3, maxRuleBindings: 0, maxProofSteps: 0, maxElapsedMs: 1000, maxEvidenceTokens: 100 } } }
  return { ports, service, request, repository, snapshot, data, store, tombstones, relationReadPort, coreReadPort, readRelationSources, searchSeeds, coreView: () => lastCore! }
}

describe('authoritative L2 to bounded recall integration', () => {
  it('keeps relation cursors valid when page scan limits change and enforces the shared view budget', async () => {
    const s = await setup({ fanout: 3 })
    const core = value(await s.coreReadPort.openView({ ...s.request.view,
      budget: { ...s.request.view.budget, maxEdges: 2 } }))
    const relation = value(await s.relationReadPort.openView({ coreView: core, expectedRelationManifestId: 'l2-1' }))
    const base = { claim: s.request.seed, direction: 'in' as const, kinds: ['causes' as const], limit: 1 }
    const first = value(await relation.neighbors({ ...base, maxScanned: 2 }))
    expect(first).toMatchObject({ scanned: 1, completion: 'more' })
    const second = value(await relation.neighbors({ ...base, maxScanned: 1, cursor: first.nextCursor }))
    expect(second).toMatchObject({ scanned: 1, completion: 'budget-exhausted' })
    const third = value(await relation.neighbors({ ...base, maxScanned: 1, cursor: second.nextCursor }))
    expect(third).toMatchObject({ items: [], scanned: 0, completion: 'budget-exhausted' })
    await relation.close()
    await core.close()
  })

  it.each(['causes', 'precedes', 'explains', 'entails', 'contradicts'] as const)('keeps %s and its authoritative metadata without renaming semantics', async kind => {
    const s = await setup({ kind })
    const result = value(await s.service.recall(s.request))
    expect(result.relations[0]!.kind).toBe(kind)
    expect(result.relations[0]!.authoritativeRecord).toMatchObject({ kind, polarity: 'positive', modality: 'asserted', assertionBasis: 'source-explicit', nliObservationIds: [] })
    expect(result.relationManifest).toMatchObject({ manifestId: 'l2-1', coreManifestId: 'core-1', relationRevision: 1 })
    expect(result.evidencePack.relationManifest).toEqual(result.relationManifest)
    expect(s.coreView().close).toHaveBeenCalledOnce()
    if (kind === 'contradicts') {
      expect(result.evidencePack.relationDisputes).toHaveLength(1)
      expect(result.evidencePack.facts.every(f => f.state === 'opposed')).toBe(true)
      expect(result.conflictAudit.pairs).toHaveLength(0) // Different predicates, explicit L2 assertion, not exact-key contradiction.
    }
  })

  it('treats contradiction as symmetric even when the seed is its from endpoint and direction is in', async () => {
    const s = await setup({ kind: 'contradicts' })
    const result = value(await s.service.recall({ ...s.request, seed: s.data.bundle.claims[0]!.ref }))
    expect(result.groups).toHaveLength(1)
    expect(result.evidencePack.relations[0]!.kind).toBe('contradicts')
  })

  it.each([{ polarity: 'negative' as const }, { modality: 'hypothetical' as const }, { unknownTime: true }])(
    'does not turn non-factual/unknown-time authoritative records into positive traversal: %j', async options => {
      const s = await setup(options)
      const result = value(await s.service.recall(s.request))
      expect(result.relations).toEqual([])
      expect(result.claims.map(c => c.record.ref.id)).toEqual(['C2'])
    })

  it('uses canonical query planning and keeps explains separate from causes', async () => {
    const s = await setup()
    const result = value(await s.service.recallQuery({ recallId: 'query', query: '张三为什么没有上班？', view: s.request.view }))
    expect(result.queryPlan.traversal).toMatchObject({ direction: 'in', kinds: ['causes'] })
    expect(result.recall!.groups).toHaveLength(1)
    expect(s.searchSeeds).toHaveBeenCalledOnce()
  })

  it('rejects legacy relation names rather than treating contributes-to as explains', async () => {
    const s = await setup()
    expect(await s.service.recall({ ...s.request, kinds: ['contributes-to'] })).toMatchObject({ ok: false, error: { code: 'unsupported-capability' } })
  })

  it('requires an explicit L2 version and closes L1 if L2 opening fails', async () => {
    const s = await setup()
    expect(await s.service.recall({ ...s.request, view: { ...s.request.view, expectedRelationManifestId: undefined } }))
      .toMatchObject({ ok: false, error: { code: 'invalid-request' } })
    expect(await s.service.recall({ ...s.request, view: { ...s.request.view, expectedRelationManifestId: 'wrong' } }))
      .toMatchObject({ ok: false, error: { code: 'version-mismatch' } })
    expect(s.coreView().close).toHaveBeenCalledOnce()
  })

  it('shares edge budgets across multiple hops', async () => {
    const s = await setup({ chain: true })
    const result = value(await s.service.recall({ ...s.request, view: { ...s.request.view, budget: { ...s.request.view.budget, maxEdges: 1 } } }))
    expect(result.scannedEdges).toBe(1)
    expect(result.groups).toHaveLength(1)
    expect(result.completeness).toBe('incomplete')
  })

  it('retrieves two hops from the authoritative repository', async () => {
    const s = await setup({ chain: true })
    const result = value(await s.service.recall(s.request))
    expect(result.groups).toHaveLength(2)
    expect(result.paths.map(p => p.depth)).toEqual([0, 1, 2])
    expect(result.evidencePack.answerConstraints.inferTransitiveConclusions).toBe(false)
  })

  it('reads L2-only sources and charges them against the combined evidence budget', async () => {
    const s = await setup({ extraSource: true })
    const enough = value(await s.service.recall(s.request))
    expect(enough.sources.some(source => source.ref.episodeId === 'relation-only')).toBe(true)
    expect(s.readRelationSources).toHaveBeenCalled()
    const partial = value(await s.service.recall({ ...s.request, view: { ...s.request.view, budget: { ...s.request.view.budget, maxEvidenceTokens: 3 } } }))
    expect(partial.groups).toEqual([])
    expect(partial.completeness).toBe('incomplete')
  })

  it('fails after source deletion, stale L2 and closed views instead of serving cached relations', async () => {
    const s = await setup()
    const view = value(await s.ports.readPort.openView(s.request.view))
    expect(value(await view.resolveRelations([s.snapshot.relations[0]!.ref]))).toHaveLength(1)
    s.tombstones.add('E1')
    expect(await view.resolveRelations([s.snapshot.relations[0]!.ref])).toMatchObject({ ok: false, error: { code: 'source-unavailable' } })
    s.tombstones.clear()
    value(await s.repository.invalidate({ operationId: 'stale', scope: s.data.bundle.scope, expectedManifestId: 'l2-1', nextManifestId: 'stale', reason: 'source-changed' }))
    expect(await view.resolveClaims([])).toMatchObject({ ok: false, error: { code: 'stale-projection' } })
    await view.close()
    expect(await view.resolveClaims([])).toMatchObject({ ok: false, error: { code: 'view-closed' } })
  })

  it('continues past 64 neighbors without treating a page limit as the entire-query budget', async () => {
    const s = await setup({ fanout: 65 })
    const result = value(await s.service.recall({ ...s.request, view: { ...s.request.view,
      budget: { ...s.request.view.budget, maxHops: 1, maxNodes: 100, maxEdges: 100 } } }))
    expect(result.groups).toHaveLength(66)
    expect(result.scannedEdges).toBe(66)
    expect(result.completeness).toBe('complete-within-declared-scope')
  })

  it('keeps candidate/NLI updates outside recalled edges and invalidates the old pinned manifest', async () => {
    const s = await setup()
    const view = value(await s.ports.readPort.openView(s.request.view))
    const record = s.snapshot.relations[0]!
    const updated: GraphRelationSnapshot = { ...s.snapshot,
      manifest: { ...s.snapshot.manifest, manifestId: 'l2-candidates-2', candidateRevision: 1 },
      candidates: [{ id: 'pending', scope: record.scope, from: record.from, to: record.to, kind: 'explains',
        context: record.context, validTime: record.validTime, sourceHints: record.provenance.sources,
        hypothesisText: '尚未采纳的解释', generator: { route: 'source-cue', version: 'test' }, resolution: { status: 'pending' } }],
      observations: [{ id: 'nli', candidateId: 'pending', premise: { kind: 'source', ref: record.evidence[0]!.source },
        premiseHash: 'premise', hypothesisHash: 'hypothesis', scores: { CONTRADICTION: 0, NEUTRAL: 0, ENTAILMENT: 1 },
        predicted: 'ENTAILMENT', modelId: 'test', modelRevision: '1', preprocessingVersion: '1', truncated: false,
        evaluatedAt: FEVER_ABSENCE_RECORDED_AT }],
    }
    value(await s.repository.publish({ operationId: 'candidate', expectedManifestId: 'l2-1', snapshot: updated }))
    expect(s.repository.snapshot().manifest).toMatchObject({ relationRevision: 1, candidateRevision: 1 })
    expect(await view.resolveClaims([])).toMatchObject({ ok: false, error: { code: 'stale-projection' } })
    await view.close()
    const result = value(await s.service.recall({ ...s.request, kinds: ['causes', 'explains'],
      view: { ...s.request.view, expectedRelationManifestId: 'l2-candidates-2' } }))
    expect(result.relations.map(r => r.kind)).toEqual(['causes'])
  })

  it('rechecks endpoint source deletion even when L2 relation sources remain available', async () => {
    const s = await setup({ extraSource: true })
    s.store.revokeSource('E1')
    expect(await s.service.recall(s.request)).toMatchObject({ ok: false, error: { code: 'source-unavailable' } })
  })

  it('refuses forged view objects in evidence readers', async () => {
    const s = await setup()
    const view = value(await s.ports.readPort.openView(s.request.view))
    expect(await s.ports.evidenceReader.readSources({ ...view }, [])).toMatchObject({ ok: false, error: { code: 'scope-denied' } })
    await view.close()
  })

  it('counts source scans over repeated L2 neighbor calls, while preserving cursor query binding', async () => {
    const s = await setup()
    const core = value(await s.coreReadPort.openView({ ...s.request.view, budget: { ...s.request.view.budget, maxEdges: 1 } }))
    const l2 = value(await s.relationReadPort.openView({ coreView: core, expectedRelationManifestId: 'l2-1' }))
    const query = { claim: s.request.seed, direction: 'in' as const, kinds: ['causes' as const], limit: 1, maxScanned: 1 }
    expect(value(await l2.neighbors(query)).scanned).toBe(1)
    expect(value(await l2.neighbors(query))).toMatchObject({ scanned: 0, completion: 'budget-exhausted' })
    await l2.close(); await core.close()
  })
})
