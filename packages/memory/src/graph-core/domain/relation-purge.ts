import type { GraphClaimRef, GraphSourceRef } from '@continuum-memory/contracts'
import type { GraphClaimRecord } from './types'
import type { GraphRelationSnapshot } from './relation-types'

/** Pure dependency closure shared by explicit purge and pre-publication V4 cleanup. */
export function pruneGraphRelationDependencies(current: GraphRelationSnapshot, targets: {
  sourceVersions: readonly GraphSourceRef[]
  claimVersions: readonly GraphClaimRef[]
}, coreClaims: readonly GraphClaimRecord[] = []) {
  const sourceKeys = new Set(targets.sourceVersions.map(sourceVersionKey))
  const claimKeys = new Set(targets.claimVersions.map(refKey))
  for (const claim of coreClaims) {
    if (claim.provenance.sources.some(source => sourceKeys.has(sourceVersionKey(source)))
      || claim.evidence.some(item => sourceKeys.has(sourceVersionKey(item.source))))
      claimKeys.add(refKey(claim.ref))
  }
  const removedCandidateIds = new Set(current.candidates
    .filter(candidate => claimKeys.has(refKey(candidate.from))
      || claimKeys.has(refKey(candidate.to))
      || candidate.sourceHints.some(source => sourceKeys.has(sourceVersionKey(source))))
    .map(candidate => candidate.id))
  const removedObservationIds = new Set(current.observations
    .filter(observation => removedCandidateIds.has(observation.candidateId)
      || (observation.premise.kind === 'claim' && claimKeys.has(refKey(observation.premise.ref)))
      || (observation.premise.kind === 'source' && sourceKeys.has(sourceVersionKey(observation.premise.ref))))
    .map(observation => observation.id))
  const removedRelationKeys = new Set(current.relations
    .filter(relation => claimKeys.has(refKey(relation.from))
      || claimKeys.has(refKey(relation.to))
      || relation.provenance.sources.some(source => sourceKeys.has(sourceVersionKey(source)))
      || relation.evidence.some(item => sourceKeys.has(sourceVersionKey(item.source)))
      || (relation.candidateId !== undefined && removedCandidateIds.has(relation.candidateId))
      || relation.nliObservationIds.some(id => removedObservationIds.has(id)))
    .map(relation => refKey(relation.ref)))
  for (const candidate of current.candidates) {
    if (candidate.resolution.status === 'accepted' && removedRelationKeys.has(refKey(candidate.resolution.relation)))
      removedCandidateIds.add(candidate.id)
  }
  for (const observation of current.observations) {
    if (removedCandidateIds.has(observation.candidateId))
      removedObservationIds.add(observation.id)
  }
  let priorSize = -1
  while (priorSize !== removedCandidateIds.size + removedObservationIds.size + removedRelationKeys.size) {
    priorSize = removedCandidateIds.size + removedObservationIds.size + removedRelationKeys.size
    for (const observation of current.observations) {
      if (removedObservationIds.has(observation.id))
        removedCandidateIds.add(observation.candidateId)
    }
    for (const relation of current.relations) {
      if (relation.nliObservationIds.some(id => removedObservationIds.has(id))
        || (relation.candidateId !== undefined && removedCandidateIds.has(relation.candidateId)))
        removedRelationKeys.add(refKey(relation.ref))
    }
    for (const candidate of current.candidates) {
      if (candidate.resolution.status === 'accepted' && removedRelationKeys.has(refKey(candidate.resolution.relation)))
        removedCandidateIds.add(candidate.id)
    }
    for (const observation of current.observations) {
      if (removedCandidateIds.has(observation.candidateId))
        removedObservationIds.add(observation.id)
    }
  }
  const relations = current.relations.filter(relation => !removedRelationKeys.has(refKey(relation.ref)))
  const candidates = current.candidates.filter(candidate => !removedCandidateIds.has(candidate.id))
  const observations = current.observations.filter(observation => !removedObservationIds.has(observation.id))
  return { relations, candidates, observations, removed: {
    removedRelations: removedRelationKeys.size, removedCandidates: removedCandidateIds.size,
    removedObservations: removedObservationIds.size,
  } }
}

function refKey(ref: { kind: string; id: string; version: number }): string {
  return JSON.stringify([ref.kind, ref.id, ref.version])
}
function sourceVersionKey(source: GraphSourceRef): string {
  return JSON.stringify([source.episodeId, source.contentHash])
}
