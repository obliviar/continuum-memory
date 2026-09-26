import { createHash } from 'node:crypto'
import type { MemoryEpisodeV4, MemoryFactV4, MemoryFactVersionV4, MemoryV4Scope, EvidenceLinkV4 } from '../../v4/domain/types'
import type { MemoryV4Repository } from '../../v4/repository/memory-v4-repository'
import { assertMemoryV4Snapshot } from '../../v4/domain/validation'

export type V4RecallInputRejection = 'inactive' | 'unverified' | 'unsupported-semantics'
  | 'unknown-time' | 'version-mismatch' | 'source-unavailable' | 'access-denied'

/** Staging input only: this is neither an accepted Claim nor a query-time evidence reader. */
export interface V4RecallInput {
  fact: MemoryFactV4
  version: MemoryFactVersionV4
  sources: { link: EvidenceLinkV4; episode: MemoryEpisodeV4 }[]
}

export interface V4RecallInputOptions {
  scope: MemoryV4Scope
  expectedRevision: number
  now: number
  /** Trusted host policy, applied to both facts and every evidence episode. */
  canRead: (record: MemoryFactV4 | MemoryEpisodeV4) => boolean
}

/** Current-state import only. Historical/as-of import requires historical policy metadata. */
export function collectV4RecallInputs(repository: MemoryV4Repository, options: V4RecallInputOptions) {
  if (!Number.isFinite(options.now) || options.now <= 0)
    throw new Error('V4 recall input requires a positive current timestamp')
  const snapshot = repository.snapshot()
  assertMemoryV4Snapshot(snapshot)
  if (snapshot.revision !== options.expectedRevision)
    throw new Error('V4 recall input revision changed; rebuild from a fresh snapshot')
  const inputs: V4RecallInput[] = []
  const rejected: { factId: string; reason: V4RecallInputRejection }[] = []
  const episodes = new Map(snapshot.episodes.map(record => [record.id, record]))
  const links = new Map(snapshot.evidenceLinks.map(record => [record.id, record]))
  const latest = new Map<string, MemoryFactVersionV4>()
  for (const version of snapshot.factVersions) {
    if (version.version > (latest.get(version.factId)?.version ?? 0))
      latest.set(version.factId, version)
  }
  for (const fact of snapshot.facts) {
    // Do not disclose even rejection identifiers across scopes.
    if (!sameScope(fact.scope, options.scope)) continue
    const reject = (reason: V4RecallInputRejection) => { rejected.push({ factId: fact.id, reason }) }
    if (!options.canRead(structuredClone(fact))) { reject('access-denied'); continue }
    if (fact.status !== 'active' || fact.invalidatedAt !== undefined
      || (fact.expiresAt !== undefined && fact.expiresAt <= options.now)
      || fact.updatedAt > options.now) { reject('inactive'); continue }
    if (fact.verificationState !== 'verified') { reject('unverified'); continue }
    if (fact.polarity === 'unknown' || fact.modality !== 'asserted' || fact.condition !== undefined
      || fact.objectType === 'json' || fact.objectType === 'entity'
      || (fact.objectType === 'date'
        ? typeof fact.normalizedValue !== 'string' || !Number.isFinite(Date.parse(fact.normalizedValue))
        : typeof fact.normalizedValue !== fact.objectType)) {
      reject('unsupported-semantics'); continue
    }
    // An absent end means an open interval; an absent start is not invented from recordedAt.
    if (fact.validFrom === undefined) { reject('unknown-time'); continue }
    const version = latest.get(fact.id)
    const fields = ['subjectId', 'predicate', 'object', 'objectType', 'normalizedValue', 'canonicalText',
      'polarity', 'modality', 'condition', 'status', 'validFrom', 'validTo', 'evidenceLinkIds'] as const
    if (!version || version.transactionClosedAt !== undefined || version.recordedAt > options.now
      || fields.some(key => JSON.stringify(fact[key]) !== JSON.stringify(version[key]))) {
      reject('version-mismatch'); continue
    }
    const sources: V4RecallInput['sources'] = []
    let failure: V4RecallInputRejection | undefined
    for (const id of version.evidenceLinkIds) {
      const link = links.get(id)
      const episode = link && episodes.get(link.episodeId)
      if (!link || !episode || !link.active || link.invalidatedAt !== undefined
        || link.createdAt > options.now || episode.recordedAt > options.now
        || !sameScope(episode.scope, fact.scope) || episode.contentState !== 'available'
        || episode.deletedAt !== undefined || !episode.content?.trim()
        || (episode.contentHash !== undefined
          && episode.contentHash !== createHash('sha256').update(episode.content, 'utf8').digest('hex'))) {
        failure = 'source-unavailable'; break
      }
      if (!options.canRead(structuredClone(episode))) { failure = 'access-denied'; break }
      sources.push({ link, episode })
    }
    if (failure) { reject(failure); continue }
    if (!sources.some(({ link }) => link.role === 'supports' && link.strength === 'direct')) {
      reject('source-unavailable'); continue
    }
    inputs.push({ fact, version, sources })
  }
  // A policy callback can observe or trigger a host update. Never publish a mixed revision.
  if (JSON.stringify(repository.snapshot()) !== JSON.stringify(snapshot))
    throw new Error('V4 recall input changed during collection; retry')
  return { revision: snapshot.revision, inputs, rejected, requiresSemanticReview: true as const }
}

function sameScope(left: MemoryV4Scope, right: MemoryV4Scope): boolean {
  return left.ownerId === right.ownerId && left.agentId === right.agentId && left.sessionId === right.sessionId
}
