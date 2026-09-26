import type { GraphClaimRef, GraphScope, GraphSourceRef, GraphTimeExtent } from '@continuum-memory/contracts'
import { MEMORY_GRAPH_PROTOCOL_VERSION } from '@continuum-memory/contracts'
import type { GraphClaimRecord, GraphProjectionSnapshot } from './types'
import { GRAPH_RELATION_SCHEMA_VERSION } from './relation-types'
import type {
  GraphNliObservation,
  GraphRelationCandidate,
  GraphRelationEdge,
  GraphRelationRecord,
  GraphRelationSnapshot,
} from './relation-types'

const RELATION_KINDS = new Set(['entails', 'contradicts', 'causes', 'precedes', 'explains'])
const LABELS = ['CONTRADICTION', 'NEUTRAL', 'ENTAILMENT'] as const
const SENSITIVITY_RANK = { normal: 0, private: 1, secret: 2 } as const
const SHARE_RANK = { 'allow-remote': 0, ask: 1, 'local-only': 2 } as const

/** Structural and exact-L1 validation. Source existence/policy still requires the trusted host. */
export function assertGraphRelationSnapshot(snapshot: GraphRelationSnapshot, core: GraphProjectionSnapshot): void {
  const manifest = snapshot.manifest
  assert(manifest.protocolVersion === MEMORY_GRAPH_PROTOCOL_VERSION, 'relation protocol version mismatch')
  assert(manifest.schemaVersion === GRAPH_RELATION_SCHEMA_VERSION, 'relation schema version mismatch')
  nonempty(manifest.manifestId, 'relation manifest ID')
  assertScope(manifest.scope, 'relation manifest scope')
  assert(manifest.coreManifestId === core.manifest.manifestId, 'relation core manifest mismatch')
  assert(manifest.sourceBundleId === core.semanticBundle.bundleId, 'relation source bundle mismatch')
  assert(sameScope(manifest.scope, core.manifest.scope) && sameScope(manifest.scope, core.semanticBundle.scope), 'relation scope differs from core')
  assert(core.manifest.state === 'ready', 'relation core manifest is not ready')
  integer(manifest.relationRevision, 'relation revision', 0)
  integer(manifest.candidateRevision, 'candidate revision', 0)
  integer(manifest.createdAt, 'relation manifest creation time', 1)
  assert(manifest.state === 'ready' || manifest.state === 'stale', 'invalid relation manifest state')

  const claims = new Map(core.semanticBundle.claims.map(claim => [refKey(claim.ref), claim]))
  const contexts = new Set(core.semanticBundle.contexts.map(context => refKey(context.ref)))
  const relations = new Map<string, GraphRelationRecord>()
  const candidates = new Map<string, GraphRelationCandidate>()
  const observations = new Map<string, GraphNliObservation>()
  const currentByLogicalKey = new Set<string>()
  const currentByRelationId = new Set<string>()

  for (const candidate of snapshot.candidates) {
    nonempty(candidate.id, 'relation candidate ID')
    assert(!candidates.has(candidate.id), 'duplicate relation candidate ID')
    candidates.set(candidate.id, candidate)
    assert(sameScope(candidate.scope, manifest.scope), 'candidate scope mismatch')
    const [from, to] = endpoints(candidate.from, candidate.to, claims, manifest.scope, candidate.resolution.status === 'pending')
    assertContext(candidate.context, contexts, from, to)
    assertTime(candidate.validTime, 'candidate valid time')
    assert(RELATION_KINDS.has(candidate.kind), 'unsupported candidate relation kind')
    assert(candidate.generator && ['dense', 'structured', 'source-cue', 'relation-neighbor', 'human'].includes(candidate.generator.route), 'unsupported candidate route')
    nonempty(candidate.generator.version, 'candidate generator version')
    nonempty(candidate.hypothesisText, 'candidate hypothesis')
    assert(Array.isArray(candidate.sourceHints), 'candidate source hints must be an array')
    candidate.sourceHints.forEach(source => assertSource(source))
    assert(['pending', 'accepted', 'rejected'].includes(candidate.resolution.status), 'invalid candidate resolution')
    if (candidate.resolution.status === 'accepted')
      assertRef(candidate.resolution.relation, 'relation')
    if (candidate.resolution.status === 'rejected')
      nonempty(candidate.resolution.reason, 'candidate rejection reason')
  }

  for (const observation of snapshot.observations) {
    nonempty(observation.id, 'NLI observation ID')
    assert(!observations.has(observation.id), 'duplicate NLI observation ID')
    observations.set(observation.id, observation)
    const candidate = candidates.get(observation.candidateId)
    assert(candidate, 'NLI observation has no candidate')
    if (observation.premise.kind === 'claim') {
      assertRef(observation.premise.ref, 'claim')
      const key = refKey(observation.premise.ref)
      assert(key === refKey(candidate.from) || key === refKey(candidate.to), 'NLI premise claim is outside candidate')
    }
    else {
      assert(observation.premise.kind === 'source', 'invalid NLI premise kind')
      const premiseSource = observation.premise.ref
      assertSource(premiseSource)
      assert(candidate.sourceHints.some(source => sourceKey(source) === sourceKey(premiseSource)), 'NLI premise source is outside candidate')
    }
    nonempty(observation.premiseHash, 'NLI premise hash')
    nonempty(observation.hypothesisHash, 'NLI hypothesis hash')
    nonempty(observation.modelId, 'NLI model ID')
    nonempty(observation.modelRevision, 'NLI model revision')
    nonempty(observation.preprocessingVersion, 'NLI preprocessing version')
    integer(observation.evaluatedAt, 'NLI evaluation time', 1)
    assert(typeof observation.truncated === 'boolean', 'NLI truncated must be boolean')
    assert(LABELS.includes(observation.predicted), 'invalid NLI prediction')
    let total = 0
    for (const label of LABELS) {
      const score = observation.scores[label]
      assert(Number.isFinite(score) && score >= 0 && score <= 1, 'invalid NLI score')
      total += score
    }
    assert(Math.abs(total - 1) <= 0.001, 'NLI scores must sum to one')
    assert(LABELS.every(label => observation.scores[observation.predicted] >= observation.scores[label] - 1e-9), 'NLI prediction differs from scores')
  }

  for (const relation of snapshot.relations) {
    assertRef(relation.ref, 'relation')
    const key = refKey(relation.ref)
    assert(!relations.has(key), 'duplicate relation version')
    relations.set(key, relation)
    assert(sameScope(relation.scope, manifest.scope), 'relation scope mismatch')
    const [from, to] = endpoints(relation.from, relation.to, claims, manifest.scope, relation.transactionTime.closedAt === null)
    assertContext(relation.context, contexts, from, to)
    assertTime(relation.validTime, 'relation valid time')
    assert(RELATION_KINDS.has(relation.kind), 'unsupported relation kind')
    assert(['positive', 'negative', 'unknown'].includes(relation.polarity), 'invalid relation polarity')
    assert(['asserted', 'planned', 'hypothetical', 'reported', 'inferred', 'unknown'].includes(relation.modality), 'invalid relation modality')
    assert(relation.modality !== 'inferred', 'inferred relation requires a proof, not an L2 source assertion')
    assert(relation.assertionBasis === 'source-explicit' || relation.assertionBasis === 'user-confirmed', 'invalid relation assertion basis')
    assert(relation.review.status === 'accepted', 'authoritative relation must be accepted')
    integer(relation.review.reviewedAt, 'relation review time', 1)
    nonempty(relation.review.reviewer, 'relation reviewer')
    integer(relation.transactionTime.recordedAt, 'relation recorded time', 1)
    if (relation.transactionTime.closedAt !== null) {
      integer(relation.transactionTime.closedAt, 'relation closed time', 1)
      assert(relation.transactionTime.closedAt > relation.transactionTime.recordedAt, 'relation closes before recording')
    }
    assert(SENSITIVITY_RANK[relation.sensitivity] >= Math.max(SENSITIVITY_RANK[from.sensitivity], SENSITIVITY_RANK[to.sensitivity]), 'relation weakens endpoint sensitivity')
    assert(SHARE_RANK[relation.sharePolicy] >= Math.max(SHARE_RANK[from.sharePolicy], SHARE_RANK[to.sharePolicy]), 'relation weakens endpoint share policy')
    assert(Array.isArray(relation.evidence) && relation.evidence.length > 0, 'relation requires evidence')
    assert(relation.evidence.some(item => item.role === 'supports'), 'relation requires supporting evidence')
    assert(Array.isArray(relation.provenance.sources) && relation.provenance.sources.length > 0, 'relation requires provenance')
    relation.provenance.sources.forEach(source => assertSource(source))
    for (const item of relation.evidence) {
      assertSource(item.source)
      assert(item.role === 'supports' || item.role === 'refutes', 'invalid relation evidence role')
      assert(relation.provenance.sources.some(source => sourceKey(source) === sourceKey(item.source)), 'relation evidence missing from provenance')
    }
    nonempty(relation.provenance.normalizerVersion, 'relation normalizer version')
    assert(['extractor', 'user', 'migration'].includes(relation.provenance.producer), 'invalid relation producer')
    if (relation.assertionBasis === 'user-confirmed')
      assert(relation.provenance.producer === 'user', 'user-confirmed relation requires user provenance')
    if (relation.kind === 'contradicts' || relation.kind === 'entails') {
      assert(!disjoint(from.validTime, to.validTime), 'logical relation has disjoint endpoint times')
      assert(from.modality === to.modality, 'logical relation has incompatible endpoint modalities')
    }
    if (relation.kind === 'contradicts')
      assert(refKey(relation.from) < refKey(relation.to), 'symmetric contradiction endpoints must be canonicalized')
    if (relation.transactionTime.closedAt === null) {
      assert(!currentByRelationId.has(relation.ref.id), 'multiple current versions of one relation')
      currentByRelationId.add(relation.ref.id)
      const logicalKey = [relation.kind, relation.polarity, relation.modality, refKey(relation.context), refKey(relation.from), refKey(relation.to), JSON.stringify(relation.validTime)].join('\u0000')
      assert(!currentByLogicalKey.has(logicalKey), 'duplicate current logical relation')
      currentByLogicalKey.add(logicalKey)
    }
  }

  for (const relation of snapshot.relations) {
    if (relation.candidateId !== undefined) {
      const candidate = candidates.get(relation.candidateId)
      assert(candidate, 'relation references missing candidate')
      assert(candidate.resolution.status === 'accepted' && refKey(candidate.resolution.relation) === refKey(relation.ref), 'relation candidate is not accepted for this version')
      assert(candidate.kind === relation.kind && refKey(candidate.from) === refKey(relation.from) && refKey(candidate.to) === refKey(relation.to), 'relation differs from its candidate')
    }
    assert(Array.isArray(relation.nliObservationIds), 'relation NLI IDs must be an array')
    for (const id of relation.nliObservationIds) {
      const observation = observations.get(id)
      assert(observation, 'relation references missing NLI observation')
      assert(relation.candidateId === observation.candidateId, 'relation NLI observation belongs to another candidate')
      assert(!observation.truncated, 'truncated NLI observation cannot support an accepted relation')
    }
  }
  for (const candidate of snapshot.candidates) {
    if (candidate.resolution.status === 'accepted')
      assert(relations.has(refKey(candidate.resolution.relation)), 'accepted candidate has no relation')
  }
}

/** Accepted current records only; callers must still recheck authorization and live sources. */
export function projectGraphRelationEdges(snapshot: GraphRelationSnapshot, knownAt?: number): readonly GraphRelationEdge[] {
  if (snapshot.manifest.state !== 'ready')
    return []
  return snapshot.relations
    .filter(relation => relation.review.status === 'accepted' && (knownAt === undefined
      ? relation.transactionTime.closedAt === null
      : relation.transactionTime.recordedAt <= knownAt
        && (relation.transactionTime.closedAt === null || knownAt < relation.transactionTime.closedAt)))
    .map(relation => ({
      id: `relation:${relation.ref.id}@${relation.ref.version}`,
      layer: 'semantic' as const,
      kind: 'relation' as const,
      relation: relation.ref,
      relationKind: relation.kind,
      from: relation.from,
      to: relation.to,
      polarity: relation.polarity,
      modality: relation.modality,
      validTime: relation.validTime,
      sensitivity: relation.sensitivity,
      sharePolicy: relation.sharePolicy,
    }))
}

function endpoints(fromRef: GraphClaimRef, toRef: GraphClaimRef, claims: Map<string, GraphClaimRecord>, scope: GraphScope, mustBeCurrent: boolean): [GraphClaimRecord, GraphClaimRecord] {
  assertRef(fromRef, 'claim')
  assertRef(toRef, 'claim')
  assert(refKey(fromRef) !== refKey(toRef), 'self-relation is not supported')
  const from = claims.get(refKey(fromRef))
  const to = claims.get(refKey(toRef))
  assert(from && to, 'relation endpoint is not an exact L1 claim version')
  assert(sameScope(from.scope, scope) && sameScope(to.scope, scope), 'relation endpoint scope mismatch')
  assert(from.review.status === 'accepted' && to.review.status === 'accepted', 'relation endpoint is not accepted')
  if (mustBeCurrent)
    assert(from.transactionTime.closedAt === null && to.transactionTime.closedAt === null, 'current relation points to closed claim')
  return [from, to]
}

function assertContext(context: { kind: string; id: string; version: number }, contexts: Set<string>, from: GraphClaimRecord, to: GraphClaimRecord): void {
  assertRef(context, 'context')
  assert(contexts.has(refKey(context)), 'relation context is not an exact L1 context version')
  assert(refKey(from.context) === refKey(context) && refKey(to.context) === refKey(context), 'relation endpoint contexts differ')
}

function assertRef(ref: { kind: string; id: string; version: number }, kind: string): void {
  assert(ref && ref.kind === kind, `invalid ${kind} reference kind`)
  nonempty(ref.id, `${kind} reference ID`)
  integer(ref.version, `${kind} reference version`, 1)
}

function assertScope(scope: GraphScope, name: string): void {
  nonempty(scope.ownerId, `${name} owner`)
  nonempty(scope.agentId, `${name} agent`)
  if (scope.sessionId !== undefined)
    nonempty(scope.sessionId, `${name} session`)
}

function sameScope(a: GraphScope, b: GraphScope): boolean {
  return a.ownerId === b.ownerId && a.agentId === b.agentId && a.sessionId === b.sessionId
}

function assertSource(source: GraphSourceRef): void {
  nonempty(source.episodeId, 'relation source episode ID')
  nonempty(source.contentHash, 'relation source content hash')
  assert(source.locator && ['whole-content', 'text-span'].includes(source.locator.kind), 'invalid relation source locator')
  if (source.locator.kind === 'text-span') {
    assert(source.locator.unit === 'utf16', 'relation source span must use UTF-16')
    integer(source.locator.start, 'relation source span start', 0)
    integer(source.locator.end, 'relation source span end', 1)
    assert(source.locator.end > source.locator.start, 'empty relation source span')
  }
}

function assertTime(time: GraphTimeExtent, name: string): void {
  assert(time && (time.kind === 'unknown' || time.kind === 'interval'), `invalid ${name}`)
  if (time.kind === 'interval') {
    if (time.from !== null)
      integer(time.from, `${name} start`, 0)
    if (time.to !== null)
      integer(time.to, `${name} end`, 0)
    assert(time.from === null || time.to === null || time.from < time.to, `${name} is empty or reversed`)
  }
}

function disjoint(a: GraphTimeExtent, b: GraphTimeExtent): boolean {
  if (a.kind === 'unknown' || b.kind === 'unknown')
    return false
  return (a.to !== null && b.from !== null && a.to <= b.from)
    || (b.to !== null && a.from !== null && b.to <= a.from)
}

function refKey(ref: { kind: string; id: string; version: number }): string {
  return `${ref.kind}\u0000${ref.id}\u0000${ref.version}`
}

function sourceKey(source: GraphSourceRef): string {
  return `${source.episodeId}\u0000${source.contentHash}\u0000${JSON.stringify(source.locator)}`
}

function nonempty(value: string, name: string): void {
  assert(typeof value === 'string' && value.trim().length > 0, `${name} is empty`)
}

function integer(value: number, name: string, min: number): void {
  assert(Number.isSafeInteger(value) && value >= min, `${name} must be an integer >= ${min}`)
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition)
    throw new Error(message)
}
