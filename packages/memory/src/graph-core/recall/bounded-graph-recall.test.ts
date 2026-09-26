import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { MEMORY_GRAPH_PROTOCOL_VERSION } from '@continuum-memory/contracts'
import type { GraphResult } from '@continuum-memory/contracts'
import type {  GraphProjectionManifest } from '../domain/types'
import type { GraphRecallRelationKind as GraphRelationKind } from '../domain/recall-types'
import type { GraphRelationValidationInput } from '../domain/validation'
import { createFeverAbsenceFixture, FEVER_ABSENCE_DAY, FEVER_ABSENCE_RECORDED_AT } from '../fixtures/fever-absence'
import type { GraphRecallReadView as GraphReadView, GraphRecallEvidenceReader as GraphEvidenceReader } from '../ports/graph-recall-ports'
import { createInMemoryGraph } from '../repository/in-memory-graph'
import { createBoundedGraphRecall } from './bounded-graph-recall'
import type { GraphTraversalRecallRequest, GraphTraversalRecallResult } from './bounded-graph-recall'

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
// Validate the entire predecessor forest, including every relation and endpoint/source reference.
function checkPaths(result: GraphTraversalRecallResult) {
  for (const path of result.paths) {
    expect(result.claims.some(c => c.record.ref.id === path.target.id)).toBe(true)
    if (!path.parent) { expect(path.depth).toBe(0); expect(path.via).toBeNull(); continue }
    const parent = result.paths.find(p => p.root.id === path.root.id && p.target.id === path.parent!.id)
    expect(parent?.depth).toBe(path.depth - 1)
    const relation = result.relations.find(r => r.ref.id === path.via!.id)!
    expect([relation.from.id, relation.to.id].sort()).toEqual([path.parent.id, path.target.id].sort())
    expect(result.groups.some(g => g.relation.id === relation.ref.id)).toBe(true)
  }
  for (const record of [...result.relations, ...result.claims.map(c => c.record)]) {
    for (const evidence of record.evidence) {
      expect(result.sources.some(s => JSON.stringify(s.ref) === JSON.stringify(evidence.source))).toBe(true)
    }
  }
}

describe('bounded graph traversal', () => {
  it('retrieves two hops with exact evidence and preserves inverse traversal without inventing transitive edges', async () => {
    const s = setup(chain())
    const result = value(await s.recall(s.request))
    expect(result.claims.map(c => c.record.ref.id)).toEqual(['C2', 'C1', 'C4'])
    expect(result.paths.map(p => [p.target.id, p.depth, p.parent?.id])).toEqual([
      ['C2', 0, undefined], ['C1', 1, 'C2'], ['C4', 2, 'C1'],
    ])
    expect(result.groups.map(g => [g.from.id, g.to.id])).toEqual([['C1', 'C2'], ['C4', 'C1']])
    expect(result.traversalTrace.map(t => [t.from.id, t.to.id])).toEqual([['C2', 'C1'], ['C1', 'C4']])
    expect(result).toMatchObject({ completeness: 'complete-within-declared-scope', stopReason: 'neighbors-exhausted',
      conflictCheck: 'complete-within-policy', interpretation: 'source-asserted-relations' })
    expect(s.opened().neighbors).toHaveBeenCalledTimes(3)
    expect(s.opened().close).toHaveBeenCalledOnce()
    checkPaths(result)
  })

  it.each([0, 1, 2])('never reads adjacency at the declared depth %i', async maxHops => {
    const s = setup(chain())
    const result = value(await s.recall(withBudget(s.request, { maxHops })))
    expect(result.searchScope.maxHops).toBe(maxHops)
    expect(result.paths.map(p => p.depth)).toEqual(Array.from({ length: maxHops + 1 }, (_, i) => i))
    expect(result.depthFrontier).toHaveLength(1)
    expect(result.stopReason).toBe('depth-limit')
    expect(result.completeness).toBe('complete-within-declared-scope')
    expect(s.opened().neighbors).toHaveBeenCalledTimes(maxHops)
    checkPaths(result)
  })

  it('follows the requested outgoing direction and relation kinds at every hop', async () => {
    const data = chain()
    link(data, 'R3', 'C4', 'C2', 'before')
    const s = setup(data)
    const result = value(await s.recall({ ...s.request, seed: data.bundle.claims.find(c => c.ref.id === 'C4')!.ref, direction: 'out' }))
    expect(result.paths.map(p => p.target.id)).toEqual(['C4', 'C1', 'C2'])
    expect(result.relations.map(r => r.ref.id)).toEqual(['R2', 'R1'])
    checkPaths(result)
  })

  it('retains a cycle-closing direct relation but never enqueues an ancestor again', async () => {
    const data = chain()
    link(data, 'R3', 'C2', 'C4')
    const s = setup(data)
    const result = value(await s.recall(withBudget(s.request, { maxHops: 10 })))
    expect(result.paths).toHaveLength(3)
    expect(result.relations).toHaveLength(3)
    expect(result.traversalTrace.at(-1)).toMatchObject({ from: { id: 'C4' }, to: { id: 'C2' }, action: 'cycle-skipped' })
    expect(s.opened().neighbors).toHaveBeenCalledTimes(3)
    checkPaths(result)
  })

  it('keeps both diamond edges but chooses one shortest predecessor path', async () => {
    const data = chain()
    addClaim(data, 'C5')
    link(data, 'R3', 'C5', 'C2')
    link(data, 'R4', 'C4', 'C5')
    const s = setup(data)
    const result = value(await s.recall(s.request))
    expect(result.paths.map(p => [p.target.id, p.depth])).toEqual([['C2', 0], ['C1', 1], ['C5', 1], ['C4', 2]])
    expect(result.relations).toHaveLength(4)
    expect(result.traversalTrace.filter(t => t.action === 'revisit-skipped')).toHaveLength(1)
    expect(vi.mocked(s.opened().neighbors).mock.calls.filter(([q]) => q.node.id === 'C4')).toHaveLength(1)
    checkPaths(result)
  })

  it('handles a shared relation in both directions without creating repeated paths', async () => {
    const s = setup()
    const result = value(await s.recall({ ...s.request, direction: 'both' }))
    expect(result.paths).toHaveLength(2)
    expect(result.groups).toHaveLength(1)
    expect(result.scannedEdges).toBe(2)
    expect(result.traversalTrace.at(-1)?.action).toBe('cycle-skipped')
    checkPaths(result)
  })

  it.each([{ maxNodes: 2 }, { maxEdges: 1 }, { maxEvidenceTokens: 3 }])(
    'shares budgets across hops and never publishes a failed group or its path: %j', async budget => {
      const s = setup(chain())
      const result = value(await s.recall(withBudget(s.request, budget)))
      expect(result).toMatchObject({ completeness: 'incomplete', stopReason: 'budget-exhausted' })
      expect(result.claims.map(c => c.record.ref.id)).toEqual(['C2', 'C1'])
      expect(result.groups).toHaveLength(1)
      expect(result.paths.map(p => p.target.id)).toEqual(['C2', 'C1'])
      expect(result.seedProgress[0]!.completion).toBe('incomplete')
      checkPaths(result)
    })

  it.each(['private', 'time', 'version', 'hypothesis', 'revoked'] as const)(
    'cannot use an ineligible intermediate record to reach more nodes: %s', async reason => {
      const data = chain()
      const claim = data.bundle.claims.find(c => c.ref.id === 'C4')!
      if (reason === 'private') Object.assign(claim, { sharePolicy: 'local-only' })
      if (reason === 'time') Object.assign(claim, { validTime: data.bundle.claims[2]!.validTime })
      if (reason === 'version') Object.assign(claim.transactionTime, { recordedAt: FEVER_ABSENCE_RECORDED_AT + 10 })
      if (reason === 'hypothesis') Object.assign(data.bundle.relations[1]!, { assertion: 'hypothesis' })
      if (reason === 'revoked') Object.assign(data.bundle.relations[1]!, { status: 'revoked' })
      addClaim(data, 'C5')
      link(data, 'R3', 'C5', 'C4')
      const s = setup(data)
      const result = value(await s.recall(s.request))
      expect(result.paths.map(p => p.target.id)).toEqual(['C2', 'C1'])
      expect(result.groups).toHaveLength(1)
      checkPaths(result)
    })

  it('rechecks availability after several hops and fails closed on source deletion', async () => {
    const s = setup(chain(), { onOpen(view) {
      vi.mocked(view.neighbors).mockRestore()
      const neighbors = view.neighbors.bind(view)
      vi.spyOn(view, 'neighbors').mockImplementation(async query => {
        const result = await neighbors(query)
        if (query.node.id === 'C4') s.store.revokeSource('E1')
        return result
      })
    } })
    const result = await s.recall(s.request)
    expect(result).toMatchObject({ ok: false, error: { code: 'source-unavailable' } })
    expect(s.opened().neighbors).toHaveBeenCalledTimes(3)
    expect(s.opened().close).toHaveBeenCalledOnce()
  })

  it('plans a question, expands multiple roots, preserves each root path and shares evidence', async () => {
    const data = chain()
    addClaim(data, 'C5', true)
    link(data, 'R3', 'C1', 'C5')
    const s = setup(data)
    const request = withBudget(s.request, { maxSeeds: 2, maxEvidenceTokens: 5 })
    const result = value(await s.recallQuery({ recallId: 'query', query: '张三为什么没有上班？', view: request.view }))
    expect(result.queryPlan.traversal).toMatchObject({ direction: 'in', kinds: ['causal', 'contributes-to'] })
    expect(result.recall!.searchScope.seeds.map(c => c.id)).toEqual(['C2', 'C5'])
    expect(result.recall!.paths.filter(p => p.target.id === 'C4').map(p => [p.root.id, p.depth])).toEqual([['C2', 2], ['C5', 2]])
    expect(result.recall!.claims).toHaveLength(4)
    expect(result.recall!.sources).toHaveLength(1)
    expect(result.recall!.scannedEdges).toBe(4)
    expect(result.recall!.seedProgress.map(p => p.completion)).toEqual(['complete', 'complete'])
    checkPaths(result.recall!)
  })

  it('does not reset the edge budget for a later root', async () => {
    const data = chain()
    addClaim(data, 'C5', true)
    link(data, 'R3', 'C1', 'C5')
    const s = setup(data)
    const request = withBudget(s.request, { maxSeeds: 2, maxEdges: 3 })
    const result = value(await s.recallQuery({ recallId: 'query', query: '张三为什么没有上班？', view: request.view })).recall!
    expect(result.seedProgress.map(p => p.completion)).toEqual(['complete', 'incomplete'])
    expect(result.scannedEdges).toBe(3)
    expect(result.paths.filter(p => p.root.id === 'C5').map(p => p.target.id)).toEqual(['C5', 'C1'])
    expect(result.completeness).toBe('incomplete')
    checkPaths(result)
  })
})
