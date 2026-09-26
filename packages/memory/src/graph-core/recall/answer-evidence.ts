import type { GraphClaimRef, GraphRelationRef, GraphResult, GraphVersionRef } from '@continuum-memory/contracts'
import type { GraphClaimRecord, } from '../domain/types'
import type { GraphRecallRelationRecord as GraphRelationRecord } from '../domain/recall-types'
import { areOppositeClaims, EXACT_CONFLICT_POLICY } from '../domain/claim-conflicts'
import type { GraphSourceContent } from '../ports/graph-recall-ports'
import type { GraphTraversalRecallData } from './graph-recall-service'
import type { GraphRelationRecord as L2RelationRecord, GraphRelationManifest } from '../domain/relation-types'
import type { GraphConflictAudit } from './conflict-check'
import type { GraphCausalAlternativeCheck } from './causal-alternatives'

/** None of these states certifies truth; even checked evidence needs source attribution. */
export type GraphEvidenceState = 'opposed' | 'unchecked' | 'no-opposition-found-within-policy'
export type GraphEvidenceUsage = 'report-disagreement' | 'attribute-with-check-gap' | 'attribute-to-source'
export interface GraphAnswerFact {
  readonly id: string
  readonly ref: GraphClaimRef
  readonly fact: GraphClaimRecord['fact']
  readonly text: string
  readonly atom: GraphClaimRecord['atom']
  readonly polarity: GraphClaimRecord['polarity']
  readonly context: GraphClaimRecord['context']
  readonly validTime: GraphClaimRecord['validTime']
  readonly role: 'retrieved' | 'counter-evidence'
  readonly citations: readonly { readonly sourceId: string; readonly role: GraphClaimRecord['evidence'][number]['role']; readonly strength: GraphClaimRecord['evidence'][number]['strength'] }[]
  readonly state: GraphEvidenceState
  readonly usage: GraphEvidenceUsage
  readonly opposingFactIds: readonly string[]
  readonly audit: GraphConflictAudit['targets'][number]['status'] | 'not-performed' | 'unsupported'
}
export interface GraphAnswerRelation {
  readonly id: string
  readonly ref: GraphRelationRef
  readonly fromFactId: string
  readonly toFactId: string
  readonly kind: GraphRelationRecord['kind']
  readonly context: GraphRelationRecord['context']
  readonly validTime: GraphRelationRecord['validTime']
  readonly citations: readonly { readonly sourceId: string; readonly role: GraphRelationRecord['evidence'][number]['role'] }[]
  /** Endpoint assessment only, NOT a separate causal-relation conflict proof. */
  readonly authoritativeRecord?: L2RelationRecord
  readonly endpointState: GraphEvidenceState
  readonly usage: GraphEvidenceUsage
}
export interface GraphAnswerPath {
  readonly id: string
  readonly rootFactId: string
  readonly targetFactId: string
  readonly depth: number
  readonly parentPathId: string | null
  readonly viaRelationId: string | null
  /** Includes every preceding claim on this path, not just its final endpoint. */
  readonly state: GraphEvidenceState
  readonly usage: GraphEvidenceUsage
}
export interface GraphAnswerEvidencePack {
  readonly schemaVersion: 1
  readonly recallId: string
  readonly manifestId: string
  readonly relationManifest?: GraphRelationManifest
  readonly policyVersion: string
  readonly scope: GraphTraversalRecallData['scope']
  readonly temporal: GraphTraversalRecallData['temporal']
  readonly interpretation: 'source-attributed-evidence-not-proof'
  readonly contentRole: 'untrusted-evidence-data'
  readonly answerConstraints: {
    readonly citeSources: true
    readonly discloseOpposition: true
    readonly discloseCheckGaps: true
    readonly inferTransitiveConclusions: false
    readonly selectUniqueCauseAutomatically: false
    readonly absenceMeansFalse: false
  }
  readonly sources: readonly (GraphSourceContent & { readonly id: string })[]
  readonly facts: readonly GraphAnswerFact[]
  readonly relations: readonly GraphAnswerRelation[]
  readonly paths: readonly GraphAnswerPath[]
  readonly disputes: readonly { readonly factId: string; readonly opposingFactId: string; readonly kind: 'opposite-polarity' }[]
  /** Explicit L2 contradiction assertions; distinct from exact opposite-polarity audit pairs. */
  readonly relationDisputes: readonly { readonly relationId: string; readonly factIds: readonly string[] }[]
  readonly alternatives: readonly {
    readonly targetFactId: string
    readonly coverage: GraphCausalAlternativeCheck['coverage']
    readonly kinds: GraphCausalAlternativeCheck['kinds']
    readonly causes: readonly { readonly factIds: readonly string[]; readonly relationIds: readonly string[] }[]
    readonly hasMultipleCauses: boolean
    readonly interpretation: 'candidates-may-coexist'
  }[]
  readonly coverage: {
    readonly searchScope: GraphTraversalRecallData['searchScope']
    readonly traversal: GraphTraversalRecallData['completeness']
    readonly stopReason: GraphTraversalRecallData['stopReason']
    readonly seeds: GraphTraversalRecallData['seedProgress']
    readonly conflictPolicy: GraphConflictAudit['policy']
    readonly conflictStatus: GraphConflictAudit['status']
    readonly conflictReason: GraphConflictAudit['reason']
    readonly auditTargets: GraphConflictAudit['targets']
    readonly pathPolicy: GraphTraversalRecallData['pathPolicy']
    readonly depthFrontier: GraphTraversalRecallData['depthFrontier']
    readonly answerSufficiency: 'not-assessed'
  }
  readonly gaps: readonly {
    readonly code: 'traversal-incomplete' | 'depth-boundary' | 'conflict-check-incomplete'
      | 'conflict-check-unsupported' | 'conflict-check-not-performed' | 'causes-incomplete' | 'causes-not-checked'
    readonly claims: readonly GraphClaimRef[]
  }[]
}

/** Pure projection of a trusted typed recall result, not a JSON/auth validator or a proof verifier. */
export function buildGraphAnswerEvidence(input: GraphTraversalRecallData): GraphResult<GraphAnswerEvidencePack> {
  try { return { ok: true, value: assemble(input) } }
  catch (error) {
    return { ok: false, error: { code: 'invalid-request', message: error instanceof EvidenceError ? error.message : 'Invalid answer evidence input' } }
  }
}

function assemble(input: GraphTraversalRecallData): GraphAnswerEvidencePack {
  const sourceIds = index(input.sources, item => sourceKey(item.ref), 'source')
  const factIds = index(input.claims, item => refKey(item.record.ref), 'fact')
  const relationIds = index(input.relations, item => refKey(item.ref), 'relation')
  const claimRecords = new Map(input.claims.map(item => [refKey(item.record.ref), item.record]))
  const relationRecords = new Map(input.relations.map(item => [refKey(item.ref), item]))
  const pathIds = index(input.paths, item => pathKey(item.root, item.target), 'path')
  const traversed = new Set(input.paths.map(path => refKey(path.target)))
  const auditTargets = new Map(input.conflictAudit.targets.map(target => [refKey(target.claim), target.status]))
  if (input.conflictCheck !== input.conflictAudit.status || input.conflictAudit.policy !== EXACT_CONFLICT_POLICY
    || auditTargets.size !== input.conflictAudit.targets.length) fail('Inconsistent conflict audit')
  for (const ref of auditTargets.keys()) {
    requireId(factIds, ref)
    if (!traversed.has(ref)) fail('Audit target was not traversed')
  }
  if (input.conflictCheck === 'complete-within-policy'
    && [...traversed].some(ref => auditTargets.get(ref) !== 'complete')) fail('Completed audit omits a traversal claim')
  const opposed = new Map<string, Set<string>>()
  const pairKeys = new Set<string>()
  const disputes = input.conflictAudit.pairs.map(pair => {
    const a = refKey(pair.claim)
    const b = refKey(pair.opposing)
    const factId = requireId(factIds, a)
    const opposingFactId = requireId(factIds, b)
    if (!areOppositeClaims(claimRecords.get(a)!, claimRecords.get(b)!, input.temporal)) fail('Invalid opposing evidence pair')
    const key = JSON.stringify([a, b].sort())
    if (pairKeys.has(key)) fail('Duplicate opposing evidence pair')
    pairKeys.add(key)
    opposed.set(a, new Set([...(opposed.get(a) ?? []), opposingFactId]))
    opposed.set(b, new Set([...(opposed.get(b) ?? []), factId]))
    return { factId, opposingFactId, kind: 'opposite-polarity' as const }
  })
  for (const relation of input.relations) {
    const authoritative = relation.authoritativeRecord
    if (authoritative && (refKey(authoritative.ref) !== refKey(relation.ref)
      || authoritative.kind !== relation.kind || refKey(authoritative.from) !== refKey(relation.from)
      || refKey(authoritative.to) !== refKey(relation.to) || authoritative.polarity !== 'positive'
      || authoritative.modality !== 'asserted' || authoritative.review.status !== 'accepted'))
      fail('Authoritative L2 record disagrees with the recall projection')
  }
  const relationDisputes = input.relations.filter(relation => relation.kind === 'contradicts' && relation.authoritativeRecord).map(relation => {
    const a = refKey(relation.from), b = refKey(relation.to)
    const first = requireId(factIds, a), second = requireId(factIds, b)
    opposed.set(a, new Set([...(opposed.get(a) ?? []), second]))
    opposed.set(b, new Set([...(opposed.get(b) ?? []), first]))
    return { relationId: requireId(relationIds, refKey(relation.ref)), factIds: [first, second] }
  })
  const facts: GraphAnswerFact[] = input.claims.map(({ record, canonicalText }) => {
    const key = refKey(record.ref)
    const opposingFactIds = [...(opposed.get(key) ?? [])]
    const audit = input.conflictCheck === 'not-performed' || input.conflictCheck === 'unsupported'
      ? input.conflictCheck : auditTargets.get(key) ?? 'not-started'
    const state: GraphEvidenceState = opposingFactIds.length > 0 ? 'opposed'
      : audit === 'complete' ? 'no-opposition-found-within-policy' : 'unchecked'
    if (!traversed.has(key) && opposingFactIds.length === 0) fail('Unlinked non-traversal claim')
    if (!record.evidence.some(e => e.role === 'supports' && e.strength === 'direct')) fail('Claim has no direct support')
    return { id: requireId(factIds, key), ref: record.ref, fact: record.fact, text: canonicalText,
      atom: record.atom, polarity: record.polarity, context: record.context, validTime: record.validTime,
      role: traversed.has(key) ? 'retrieved' : 'counter-evidence',
      citations: record.evidence.map(e => ({ sourceId: requireId(sourceIds, sourceKey(e.source)), role: e.role, strength: e.strength })),
      state, usage: usage(state), opposingFactIds, audit }
  })
  const factStates = new Map(facts.map(fact => [fact.id, fact.state]))
  const groups = index(input.groups, group => refKey(group.relation), 'group')
  if (groups.size !== relationIds.size) fail('Relation groups do not cover exact relations')
  for (const group of input.groups) {
    const relation = relationRecords.get(refKey(group.relation))
    if (!relation || refKey(group.from) !== refKey(relation.from) || refKey(group.to) !== refKey(relation.to)) fail('Relation group endpoints disagree')
  }
  const relations: GraphAnswerRelation[] = input.relations.map(relation => {
    const fromFactId = requireId(factIds, refKey(relation.from))
    const toFactId = requireId(factIds, refKey(relation.to))
    const endpointState = mergeState(factStates.get(fromFactId)!, factStates.get(toFactId)!)
    if (relation.assertion !== 'explicit-claim' || relation.status !== 'active' || relation.support !== 'supported'
      || !relation.evidence.some(e => e.role === 'supports')) fail('Relation is not supported explicit evidence')
    return { id: requireId(relationIds, refKey(relation.ref)), ref: relation.ref, fromFactId, toFactId,
      kind: relation.kind, context: relation.context, validTime: relation.validTime,
      citations: relation.evidence.map(e => ({ sourceId: requireId(sourceIds, sourceKey(e.source)), role: e.role })),
      authoritativeRecord: relation.authoritativeRecord, endpointState, usage: usage(endpointState) }
  })
  const roots = new Set(input.searchScope.seeds.map(refKey))
  const pathMap = new Map<string, GraphAnswerPath>()
  for (const path of [...input.paths].sort((a, b) => a.depth - b.depth)) {
    const key = pathKey(path.root, path.target)
    if (!roots.has(refKey(path.root)) || !Number.isSafeInteger(path.depth) || path.depth < 0 || path.depth > input.searchScope.maxHops)
      fail('Invalid path root or depth')
    const rootFactId = requireId(factIds, refKey(path.root))
    const targetFactId = requireId(factIds, refKey(path.target))
    let state = factStates.get(targetFactId)!
    let parentPathId: string | null = null
    let viaRelationId: string | null = null
    if (path.depth === 0) {
      if (path.parent !== null || path.via !== null || rootFactId !== targetFactId) fail('Invalid root path')
    }
    else {
      if (!path.parent || !path.via) fail('Path is missing a predecessor or relation')
      const parent = pathMap.get(pathKey(path.root, path.parent))
      const relation = relationRecords.get(refKey(path.via))
      if (!parent || parent.depth !== path.depth - 1 || !relation) fail('Broken path predecessor')
      const forward = refKey(relation.from) === refKey(path.parent) && refKey(relation.to) === refKey(path.target)
      const reverse = refKey(relation.to) === refKey(path.parent) && refKey(relation.from) === refKey(path.target)
      if (!input.searchScope.kinds.includes(relation.kind)
        || !((relation.kind === 'contradicts' && (forward || reverse)) || (input.searchScope.direction !== 'in' && forward) || (input.searchScope.direction !== 'out' && reverse)))
        fail('Path relation disagrees with traversal direction or endpoints')
      parentPathId = parent.id
      viaRelationId = requireId(relationIds, refKey(path.via))
      state = mergeState(parent.state, state)
    }
    pathMap.set(key, { id: requireId(pathIds, key), rootFactId, targetFactId, depth: path.depth,
      parentPathId, viaRelationId, state, usage: usage(state) })
  }
  for (const frontier of input.depthFrontier) {
    if (pathMap.get(pathKey(frontier.root, frontier.node))?.depth !== input.searchScope.maxHops) fail('Invalid depth frontier')
  }
  const alternatives = input.causalAlternatives.map(check => ({
    targetFactId: requireId(factIds, refKey(check.target)), coverage: check.coverage, kinds: check.kinds,
    causes: check.causes.map(cause => ({ factIds: cause.claims.map(ref => requireId(factIds, refKey(ref))),
      relationIds: cause.relations.map(ref => {
        const relation = relationRecords.get(refKey(ref))
        if (!relation || refKey(relation.to) !== refKey(check.target)
          || !cause.claims.some(claim => refKey(claim) === refKey(relation.from))) fail('Invalid alternative cause reference')
        return requireId(relationIds, refKey(ref))
      }) })),
    hasMultipleCauses: check.hasMultipleCauses, interpretation: 'candidates-may-coexist' as const,
  }))
  const gaps: Array<GraphAnswerEvidencePack['gaps'][number]> = []
  if (input.completeness === 'incomplete') gaps.push({ code: 'traversal-incomplete', claims: input.seedProgress.filter(s => s.completion !== 'complete').map(s => s.seed) })
  if (input.depthFrontier.length) gaps.push({ code: 'depth-boundary', claims: uniqueRefs(input.depthFrontier.map(item => item.node)) })
  if (input.conflictCheck !== 'complete-within-policy') {
    const code = input.conflictCheck === 'not-performed' ? 'conflict-check-not-performed'
      : input.conflictCheck === 'unsupported' ? 'conflict-check-unsupported' : 'conflict-check-incomplete'
    gaps.push({ code, claims: uniqueRefs(input.paths.map(p => p.target)).filter(ref => auditTargets.get(refKey(ref)) !== 'complete') })
  }
  for (const [coverage, code] of [['incomplete', 'causes-incomplete'], ['not-checked', 'causes-not-checked']] as const) {
    const claims = input.causalAlternatives.filter(c => c.coverage === coverage).map(c => c.target)
    if (claims.length) gaps.push({ code, claims })
  }
  return structuredClone({ schemaVersion: 1, recallId: input.recallId, manifestId: input.manifestId, relationManifest: input.relationManifest,
    policyVersion: input.policyVersion, scope: input.scope, temporal: input.temporal,
    interpretation: 'source-attributed-evidence-not-proof', contentRole: 'untrusted-evidence-data',
    answerConstraints: { citeSources: true, discloseOpposition: true, discloseCheckGaps: true,
      inferTransitiveConclusions: false, selectUniqueCauseAutomatically: false, absenceMeansFalse: false },
    sources: input.sources.map(source => ({ ...source, id: requireId(sourceIds, sourceKey(source.ref)) })),
    facts, relations, paths: input.paths.map(path => pathMap.get(pathKey(path.root, path.target))!), disputes, relationDisputes, alternatives,
    coverage: { searchScope: input.searchScope, traversal: input.completeness, stopReason: input.stopReason,
      seeds: input.seedProgress, conflictPolicy: input.conflictAudit.policy, conflictStatus: input.conflictCheck,
      conflictReason: input.conflictAudit.reason, auditTargets: input.conflictAudit.targets,
      pathPolicy: input.pathPolicy, depthFrontier: input.depthFrontier, answerSufficiency: 'not-assessed' }, gaps })
}

class EvidenceError extends Error {}
function fail(message: string): never { throw new EvidenceError(message) }
function refKey(ref: GraphVersionRef<string>): string { return JSON.stringify([ref.kind, ref.id, ref.version]) }
function pathKey(root: GraphClaimRef, target: GraphClaimRef): string { return JSON.stringify([refKey(root), refKey(target)]) }
function sourceKey(ref: GraphSourceContent['ref']): string {
  return JSON.stringify([ref.episodeId, ref.contentHash, ref.locator.kind,
    ...(ref.locator.kind === 'text-span' ? [ref.locator.unit, ref.locator.start, ref.locator.end] : [])])
}
function index<T>(items: readonly T[], key: (item: T) => string, prefix: string): Map<string, string> {
  const result = new Map<string, string>()
  items.forEach((item, i) => { const id = key(item); if (result.has(id)) fail(`Duplicate ${prefix} reference`); result.set(id, `${prefix}-${i + 1}`) })
  return result
}
function requireId(ids: ReadonlyMap<string, string>, key: string): string {
  const id = ids.get(key)
  if (!id) fail('Evidence contains a dangling exact reference')
  return id
}
function uniqueRefs(refs: readonly GraphClaimRef[]): GraphClaimRef[] { return [...new Map(refs.map(ref => [refKey(ref), ref])).values()] }
function mergeState(a: GraphEvidenceState, b: GraphEvidenceState): GraphEvidenceState {
  return a === 'opposed' || b === 'opposed' ? 'opposed' : a === 'unchecked' || b === 'unchecked' ? 'unchecked' : 'no-opposition-found-within-policy'
}
function usage(state: GraphEvidenceState): GraphEvidenceUsage {
  return state === 'opposed' ? 'report-disagreement' : state === 'unchecked' ? 'attribute-with-check-gap' : 'attribute-to-source'
}
