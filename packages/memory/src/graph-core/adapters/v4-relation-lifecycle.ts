import { randomUUID } from 'node:crypto'
import type { GraphClaimRef, GraphScope, GraphSourceRef } from '@continuum-memory/contracts'
import type { MemoryV4Snapshot } from '../../v4/domain/types'
import { assertMemoryV4Snapshot } from '../../v4/domain/validation'
import { pruneGraphRelationDependencies } from '../domain/relation-purge'
import type { GraphRelationSnapshot } from '../domain/relation-types'
import type { GraphRelationPersistence } from '../repository/relation-repository'
import { v4FactIdFromClaim } from './v4-semantic-adapter'

/** Run synchronously BEFORE committing a V4 payload, including shadow writes with graph mode off.
 * Pruning may succeed even if the later V4 save fails: fail closed, never restore deleted L2 data.
 * On startup, invalidate=false only removes leftovers; it never promotes a stale view to ready.
 */
export function reconcileV4RelationLifecycle(persistence: GraphRelationPersistence, nextV4: MemoryV4Snapshot,
  options: { invalidate?: boolean; now?: () => number } = {}) {
  const empty = { changed: false, removedRelations: 0, removedCandidates: 0, removedObservations: 0 }
  const payload = persistence.load()
  if (!payload || payload === '{}') return empty
  assertMemoryV4Snapshot(nextV4)
  const current = JSON.parse(payload) as GraphRelationSnapshot
  assertLifecycleCheckpoint(current)
  const scope = current.manifest.scope
  const facts = new Map(nextV4.facts.map(fact => [fact.id, fact]))
  const episodes = new Map(nextV4.episodes.map(episode => [episode.id, episode]))
  const links = new Map(nextV4.evidenceLinks.map(link => [link.id, link]))
  function unavailableEpisode(id: string): boolean {
    const episode = episodes.get(id)
    return !episode || !sameScope(episode.scope, scope) || episode.contentState === 'deleted'
      || episode.deletedAt !== undefined
  }
  const claimVersions: GraphClaimRef[] = [], sourceVersions: GraphSourceRef[] = []
  function claim(ref: GraphClaimRef) {
    const factId = v4FactIdFromClaim(ref)
    // This adapter owns only the exact V4 mapping format, not arbitrary graph identities.
    if (factId === undefined) return
    const fact = facts.get(factId)
    if (!fact || !sameScope(fact.scope, scope) || fact.status === 'deleted'
      || fact.metadata?.purgeCompletedAt !== undefined
      || fact.evidenceLinkIds.some(id => { const link = links.get(id); return link && unavailableEpisode(link.episodeId) }))
      claimVersions.push(ref)
  }
  function source(ref: GraphSourceRef) {
    if (unavailableEpisode(ref.episodeId)) sourceVersions.push(ref)
  }
  for (const relation of current.relations) {
    claim(relation.from); claim(relation.to)
    relation.provenance.sources.forEach(source)
    relation.evidence.forEach(evidence => source(evidence.source))
  }
  for (const candidate of current.candidates) {
    claim(candidate.from); claim(candidate.to); candidate.sourceHints.forEach(source)
  }
  for (const observation of current.observations) {
    if (observation.premise.kind === 'claim') claim(observation.premise.ref)
    else source(observation.premise.ref)
  }
  const pruned = pruneGraphRelationDependencies(current, { claimVersions, sourceVersions })
  const removed = Object.values(pruned.removed).some(count => count > 0)
  if (!removed && (options.invalidate === false || current.manifest.state === 'stale')) return empty
  const timestamp = options.now?.() ?? Date.now()
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) throw new Error('Invalid L2 lifecycle timestamp')
  const next: GraphRelationSnapshot = {
    manifest: { ...current.manifest, manifestId: `lifecycle:${randomUUID()}`, state: 'stale',
      createdAt: Math.max(timestamp, current.manifest.createdAt),
      relationRevision: current.manifest.relationRevision + Number(pruned.removed.removedRelations > 0),
      candidateRevision: current.manifest.candidateRevision
        + Number(pruned.removed.removedCandidates + pruned.removed.removedObservations > 0) },
    relations: pruned.relations, candidates: pruned.candidates, observations: pruned.observations,
  }
  if (persistence.load() !== payload) throw new Error('L2 changed during lifecycle cleanup; retry from current state')
  const serialized = JSON.stringify(next)
  persistence.save(serialized)
  if (persistence.load() !== serialized) throw new Error('L2 lifecycle cleanup was not persisted')
  return { changed: true, ...pruned.removed }
}

function sameScope(a: GraphScope, b: GraphScope): boolean {
  return a.ownerId === b.ownerId && a.agentId === b.agentId && a.sessionId === b.sessionId
}

function assertLifecycleCheckpoint(snapshot: GraphRelationSnapshot): void {
  const manifest = snapshot?.manifest
  if (manifest?.protocolVersion !== 'memory-graph/v1' || manifest.schemaVersion !== 1
    || !manifest.scope?.ownerId || !manifest.scope.agentId || !manifest.manifestId
    || !['ready', 'stale'].includes(manifest.state)
    || !Number.isSafeInteger(manifest.relationRevision) || manifest.relationRevision < 0
    || !Number.isSafeInteger(manifest.candidateRevision) || manifest.candidateRevision < 0
    || !Number.isSafeInteger(manifest.createdAt) || manifest.createdAt <= 0
    || !Array.isArray(snapshot.relations) || !Array.isArray(snapshot.candidates)
    || !Array.isArray(snapshot.observations)) throw new Error('Invalid L2 lifecycle checkpoint')
}
