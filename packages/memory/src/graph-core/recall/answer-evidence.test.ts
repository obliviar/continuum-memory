import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { MEMORY_GRAPH_PROTOCOL_VERSION } from '@continuum-memory/contracts'
import type { GraphResult } from '@continuum-memory/contracts'
import type {  GraphProjectionManifest } from '../domain/types'
import type { GraphRecallRelationKind as GraphRelationKind } from '../domain/recall-types'
import type { GraphRelationValidationInput } from '../domain/validation'
import { createFeverAbsenceFixture, FEVER_ABSENCE_DAY, FEVER_ABSENCE_RECORDED_AT } from '../fixtures/fever-absence'
import type { GraphRecallReadView as GraphReadView, GraphRecallEvidenceReader as GraphEvidenceReader } from '../ports/graph-recall-ports'
import { buildGraphAnswerEvidence } from './answer-evidence'
import { createOneHopGraphRecall } from './one-hop-recall'
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

describe('answer evidence packets', () => {
  it('links facts and relations to exact source citations without promoting source assertions to proof', async () => {
    const s = setup()
    const result = value(await s.recall(s.request))
    const pack = result.evidencePack
    expect(pack.sources).toHaveLength(1)
    expect(pack.sources[0]!.ref).toEqual(result.sources[0]!.ref)
    expect(pack.sources[0]!.content).toEqual(result.sources[0]!.content)
    expect(pack.facts.map(f => [f.ref.id, f.polarity, f.state, f.usage])).toEqual([
      ['C2', 'negative', 'no-opposition-found-within-policy', 'attribute-to-source'],
      ['C1', 'positive', 'no-opposition-found-within-policy', 'attribute-to-source'],
    ])
    for (const record of [...pack.facts, ...pack.relations]) {
      expect(record.citations.every(c => pack.sources.some(source => source.id === c.sourceId))).toBe(true)
    }
    const relation = pack.relations[0]!
    expect(pack.facts.find(f => f.id === relation.fromFactId)!.ref.id).toBe('C1')
    expect(pack.facts.find(f => f.id === relation.toFactId)!.ref.id).toBe('C2')
    expect(pack).toMatchObject({ schemaVersion: 1, manifestId: 'm1', interpretation: 'source-attributed-evidence-not-proof',
      contentRole: 'untrusted-evidence-data', answerConstraints: { inferTransitiveConclusions: false, absenceMeansFalse: false },
      coverage: { answerSufficiency: 'not-assessed', conflictStatus: 'complete-within-policy' } })
    expect(s.opened().close).toHaveBeenCalledOnce()
  })

  it('propagates an intermediate dispute through the path without changing a clean downstream fact or relation', async () => {
    const data = chain()
    Object.assign(data.bundle.claims.find(c => c.ref.id === 'C4')!.atom.args, { symptom: { kind: 'string', value: 'upstream' } })
    const c5 = addClaim(data, 'C5')
    Object.assign(c5.atom.args, { symptom: { kind: 'string', value: 'further-upstream' } })
    link(data, 'R3', 'C5', 'C4')
    opposite(data, 'C1')
    const s = setup(data)
    const pack = value(await s.recall(withBudget(s.request, { maxHops: 4 }))).evidencePack
    const terminal = pack.facts.find(f => f.ref.id === 'C5')!
    expect(terminal.state).toBe('no-opposition-found-within-policy')
    expect(pack.relations.find(r => r.ref.id === 'R3')!.endpointState).toBe('no-opposition-found-within-policy')
    const path = pack.paths.find(p => p.targetFactId === terminal.id)!
    expect(path).toMatchObject({ depth: 3, state: 'opposed', usage: 'report-disagreement' })
    let current = path
    const visited = [terminal.ref.id]
    while (current.parentPathId) {
      expect(pack.relations.some(r => r.id === current.viaRelationId)).toBe(true)
      current = pack.paths.find(p => p.id === current.parentPathId)!
      visited.push(pack.facts.find(f => f.id === current.targetFactId)!.ref.id)
    }
    expect(visited).toEqual(['C5', 'C4', 'C1', 'C2'])
    const counter = pack.facts.find(f => f.ref.id === 'opposite')!
    expect(counter.role).toBe('counter-evidence')
    expect(counter.usage).toBe('report-disagreement')
    expect(pack.paths.some(p => p.targetFactId === counter.id)).toBe(false)
    expect(pack.disputes).toHaveLength(1)
    expect(pack.facts.find(f => f.ref.id === 'C1')!.opposingFactIds).toContain(counter.id)
  })

  it('keeps incomplete audit states distinct from a completed traversal', async () => {
    const data = createFeverAbsenceFixture()
    opposite(data)
    const s = setup(data, { maxConflictScanned: 1 })
    const pack = value(await s.recall(s.request)).evidencePack
    expect(pack.coverage).toMatchObject({ traversal: 'complete-within-declared-scope', conflictStatus: 'incomplete' })
    expect(pack.facts.every(f => f.state === 'unchecked' && f.usage === 'attribute-with-check-gap')).toBe(true)
    expect(pack.paths.every(p => p.state === 'unchecked')).toBe(true)
    expect(pack.gaps.some(g => g.code === 'conflict-check-incomplete')).toBe(true)
    expect(pack.disputes).toEqual([])
  })

  it('preserves completed per-claim checks when another target exhausts the audit budget', async () => {
    const s = setup(undefined, { maxConflictScanned: 1 })
    const pack = value(await s.recall(s.request)).evidencePack
    expect(pack.facts.find(f => f.ref.id === 'C2')!.state).toBe('no-opposition-found-within-policy')
    expect(pack.facts.find(f => f.ref.id === 'C1')!.state).toBe('unchecked')
    expect(pack.gaps.find(g => g.code === 'conflict-check-incomplete')!.claims.map(c => c.id)).toEqual(['C1'])
  })

  it('links multiple causes to their source-backed relations and retains coexistence rather than choosing a winner', async () => {
    const data = createFeverAbsenceFixture()
    const c4 = addClaim(data, 'C4')
    Object.assign(c4.atom.args, { symptom: { kind: 'string', value: 'headache' } })
    link(data, 'R2', 'C4', 'C2', 'contributes-to')
    const s = setup(data)
    const pack = value(await s.recall({ ...s.request, kinds: ['causal', 'contributes-to'] })).evidencePack
    const target = pack.facts.find(f => f.ref.id === 'C2')!
    const check = pack.alternatives.find(a => a.targetFactId === target.id)!
    expect(check).toMatchObject({ hasMultipleCauses: true, interpretation: 'candidates-may-coexist' })
    expect(check.causes).toHaveLength(2)
    for (const cause of check.causes) {
      expect(cause.factIds.every(id => pack.facts.some(f => f.id === id))).toBe(true)
      expect(cause.relationIds.every(id => pack.relations.some(r => r.id === id && r.toFactId === target.id))).toBe(true)
    }
    expect(pack.answerConstraints.selectUniqueCauseAutomatically).toBe(false)
  })

  it('reports depth boundaries and traversal cutoffs separately', async () => {
    const s = setup(chain())
    const depth = value(await s.recall(withBudget(s.request, { maxHops: 1 }))).evidencePack
    expect(depth.gaps.some(g => g.code === 'depth-boundary')).toBe(true)
    expect(depth.gaps.some(g => g.code === 'traversal-incomplete')).toBe(false)
    const partial = value(await s.recall(withBudget(s.request, { maxEdges: 1 }))).evidencePack
    expect(partial.gaps.some(g => g.code === 'traversal-incomplete')).toBe(true)
    expect(partial.paths).toHaveLength(2)
    expect(partial.relations).toHaveLength(1)
  })

  it('retains planned but not-started roots as coverage gaps rather than fabricating evidence', async () => {
    const data = chain()
    addClaim(data, 'C5', true)
    link(data, 'R3', 'C1', 'C5')
    const s = setup(data)
    const request = withBudget(s.request, { maxSeeds: 2, maxEdges: 1 })
    const result = value(await s.recallQuery({ recallId: 'query', query: '张三为什么没有上班？', view: request.view }))
    const pack = result.recall!.evidencePack
    expect(pack.coverage.seeds.map(s => s.completion)).toEqual(['incomplete', 'not-started'])
    expect(pack.facts.some(f => f.ref.id === 'C5')).toBe(false)
    expect(pack.gaps.find(g => g.code === 'traversal-incomplete')!.claims.map(c => c.id)).toContain('C5')
  })

  it('does not invent packets for clarification or no-match query results', async () => {
    const s = setup()
    const missing = value(await s.recallQuery({ recallId: 'query', query: '为什么？', view: s.request.view }))
    expect(missing.status).toBe('needs-clarification')
    expect(missing.recall).toBeNull()
    const none = value(await s.recallQuery({ recallId: 'query', query: '宇航员为什么移居火星？', view: s.request.view }))
    expect(none.status).toBe('no-match')
    expect(none.recall).toBeNull()
  })

  it('reports unperformed checks in the single-hop compatibility packet', async () => {
    const s = setup()
    const service = createOneHopGraphRecall({ readPort: s.store, evidenceReader: s.store.evidenceReader })
    const pack = value(await service.recall(s.request)).evidencePack
    expect(pack.coverage.conflictStatus).toBe('not-performed')
    expect(pack.gaps.some(g => g.code === 'conflict-check-not-performed')).toBe(true)
    expect(pack.facts.every(f => f.state === 'unchecked')).toBe(true)
  })

  it('reports an unsupported conflict adapter without declaring the evidence uncontested', async () => {
    const s = setup(undefined, { onOpen(view) { Object.assign(view, { conflictPolicy: undefined }) } })
    const pack = value(await s.recall(s.request)).evidencePack
    expect(pack.coverage.conflictStatus).toBe('unsupported')
    expect(pack.gaps.some(g => g.code === 'conflict-check-unsupported')).toBe(true)
    expect(pack.facts.every(f => f.state === 'unchecked')).toBe(true)
  })

  it('is deterministic, detached from raw records, and leaves source text as evidence data', async () => {
    const s = setup()
    const raw = value(await s.recall(s.request))
    const a = value(buildGraphAnswerEvidence(raw))
    const b = value(buildGraphAnswerEvidence(raw))
    expect(a).toEqual(b)
    Object.assign(a.facts[0]!.atom, { predicate: 'mutated' })
    Object.assign(a.sources[0]!, { content: 'mutated' })
    expect(raw.claims[0]!.record.atom.predicate).not.toBe('mutated')
    expect(raw.sources[0]!.content).not.toBe('mutated')
    expect(b.sources[0]!.content).not.toBe('mutated')
    expect(b.contentRole).toBe('untrusted-evidence-data')
  })

  it.each(['missing-source', 'source-version', 'missing-claim', 'wrong-group', 'missing-relation', 'reversed-path', 'cyclic-path', 'false-complete-audit', 'duplicate-path'])(
    'refuses a structurally broken packet: %s', async broken => {
      const s = setup(chain(), { maxConflictScanned: 1 })
      const raw = value(await s.recall(s.request))
      if (broken === 'missing-source') Object.assign(raw, { sources: [] })
      if (broken === 'source-version') Object.assign(raw.sources[0]!.ref, { contentHash: 'different-version' })
      if (broken === 'missing-claim') Object.assign(raw, { claims: raw.claims.slice(1) })
      if (broken === 'wrong-group') Object.assign(raw.groups[0]!, { from: raw.groups[0]!.to })
      if (broken === 'missing-relation') Object.assign(raw, { relations: [] })
      if (broken === 'reversed-path') Object.assign(raw.searchScope, { direction: 'out' })
      if (broken === 'cyclic-path') Object.assign(raw.paths[1]!, { parent: raw.paths[1]!.target })
      if (broken === 'false-complete-audit') { Object.assign(raw.conflictAudit, { status: 'complete-within-policy' }); Object.assign(raw, { conflictCheck: 'complete-within-policy' }) }
      if (broken === 'duplicate-path') Object.assign(raw, { paths: [...raw.paths, raw.paths[0]!] })
      expect(buildGraphAnswerEvidence(raw)).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
    })

  it('refuses a dispute whose opposing endpoint is missing', async () => {
    const data = createFeverAbsenceFixture()
    opposite(data)
    const s = setup(data)
    const raw = value(await s.recall(s.request))
    Object.assign(raw, { claims: raw.claims.filter(c => c.record.ref.id !== 'opposite') })
    expect(buildGraphAnswerEvidence(raw)).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
  })
})
