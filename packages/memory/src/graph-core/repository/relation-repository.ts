import type { GraphClaimRef, GraphResult, GraphScope, GraphSourceRef } from '@continuum-memory/contracts'
import { MEMORY_GRAPH_PROTOCOL_VERSION } from '@continuum-memory/contracts'
import type { GraphProjectionSnapshot } from '../domain/types'
import { assertGraphRelationSnapshot } from '../domain/relation-core'
import { pruneGraphRelationDependencies } from '../domain/relation-purge'
import { GRAPH_RELATION_SCHEMA_VERSION } from '../domain/relation-types'
import type { GraphRelationRecord, GraphRelationSnapshot } from '../domain/relation-types'

export interface GraphRelationPersistence {
  load: () => string | undefined
  /** Must atomically replace the complete serialized snapshot before returning. */
  save: (payload: string) => void
  readonly storagePath?: string
}

export interface GraphRelationRepositoryOptions {
  readonly coreSnapshot: () => GraphProjectionSnapshot
  /** Trusted host checks exact source versions, live tombstones, scope, and that relation policies do not weaken source policies. */
  readonly verifySources: (refs: readonly GraphSourceRef[], scope: GraphScope, relations: readonly GraphRelationRecord[]) => Promise<GraphResult<void>>
  /** Omitting persistence is intended only for tests or ephemeral prototypes. */
  readonly persistence?: GraphRelationPersistence
  readonly now?: () => number
}

export interface GraphRelationRepository {
  snapshot: () => GraphRelationSnapshot
  /** Avoid copying all relations for each page's live-manifest check. */
  currentManifest?: () => GraphRelationSnapshot['manifest']
  publish: (request: {
    readonly operationId: string
    readonly expectedManifestId: string
    readonly snapshot: GraphRelationSnapshot
  }) => Promise<GraphResult<{ readonly manifestId: string; readonly relationRevision: number }>>
  invalidate: (request: {
    readonly operationId: string
    readonly scope: GraphScope
    readonly expectedManifestId: string
    readonly nextManifestId: string
    readonly reason: 'core-changed' | 'source-deleted' | 'source-changed' | 'authorization-changed' | 'policy-changed'
  }) => Promise<GraphResult<{ readonly invalidated: boolean }>>
  purge: (request: {
    readonly operationId: string
    readonly scope: GraphScope
    readonly expectedManifestId: string
    readonly nextManifestId: string
    readonly sourceVersions: readonly GraphSourceRef[]
    readonly claimVersions: readonly GraphClaimRef[]
  }) => Promise<GraphResult<{ readonly removedRelations: number; readonly removedCandidates: number; readonly removedObservations: number }>>
}

/** Separate L2 store. No V4 payload or graph navigation snapshot is rewritten. */
export function createGraphRelationRepository(options: GraphRelationRepositoryOptions): GraphRelationRepository {
  const core = options.coreSnapshot()
  let persisted = options.persistence?.load()
  let current = persisted === undefined
    ? createEmptyGraphRelationSnapshot(core, options.now?.() ?? Date.now())
    : parsePersisted(persisted, core)
  let writing = false
  const unchanged = () => options.persistence?.load() === persisted
  // Synchronous load/save protects instances in this host event loop. Cross-process
  // writers require a persistence-level lock/CAS; atomic replacement alone is insufficient.
  function persist(next: GraphRelationSnapshot): boolean {
    if (!unchanged()) return false
    const payload = JSON.stringify(next)
    options.persistence?.save(payload)
    if (options.persistence && options.persistence.load() !== payload) return false
    persisted = options.persistence ? payload : undefined
    current = JSON.parse(payload) as GraphRelationSnapshot
    return true
  }

  return {
    currentManifest: () => clone({ ...current.manifest, ...(!unchanged() ? { state: 'stale' as const } : {}) }),
    snapshot: () => {
      const snapshot = clone(current)
      return unchanged() ? snapshot : { ...snapshot, manifest: { ...snapshot.manifest, state: 'stale' } }
    },
    async publish(request) {
      if (writing)
        return error('not-ready', 'A relation publication is in progress')
      if (!request.operationId.trim())
        return error('invalid-request', 'Relation operation ID is empty')
      if (request.expectedManifestId !== current.manifest.manifestId || !unchanged())
        return error('version-mismatch', 'Relation manifest changed')
      writing = true
      try {
        const nextCore = options.coreSnapshot()
        let next: GraphRelationSnapshot
        try {
          next = clone(request.snapshot)
          assertGraphRelationSnapshot(next, nextCore)
          assertPublishTransition(current, next)
        }
        catch (cause) {
          return error('invalid-request', message(cause))
        }
        const refs = gatherSources(next)
        let verified: GraphResult<void>
        try {
          verified = await options.verifySources(refs, clone(next.manifest.scope), clone(next.relations))
        }
        catch {
          return error('source-unavailable', 'Relation sources could not be verified')
        }
        if (!verified.ok)
          return verified
        const liveCore = options.coreSnapshot()
        if (liveCore.manifest.state !== 'ready' || liveCore.manifest.manifestId !== nextCore.manifest.manifestId)
          return error('stale-projection', 'Core graph changed during relation publication')
        if (!persist(next))
          return error('version-mismatch', 'Persisted relation snapshot changed during publication')
        return { ok: true, value: { manifestId: current.manifest.manifestId, relationRevision: current.manifest.relationRevision } }
      }
      finally {
        writing = false
      }
    },
    async invalidate(request) {
      if (writing)
        return error('not-ready', 'A relation publication is in progress')
      if (!request.operationId.trim() || !request.nextManifestId.trim())
        return error('invalid-request', 'Relation operation or next manifest ID is empty')
      if (request.expectedManifestId !== current.manifest.manifestId || !unchanged())
        return error('version-mismatch', 'Relation manifest changed')
      if (!sameScope(request.scope, current.manifest.scope))
        return error('scope-denied', 'Relation scope mismatch')
      if (request.nextManifestId === current.manifest.manifestId)
        return error('invalid-request', 'Next relation manifest ID must change')
      writing = true
      try {
        const next: GraphRelationSnapshot = {
          ...current,
          manifest: {
            ...current.manifest,
            manifestId: request.nextManifestId,
            createdAt: Math.max(options.now?.() ?? Date.now(), current.manifest.createdAt),
            state: 'stale',
          },
        }
        if (!persist(next))
          return error('version-mismatch', 'Persisted relation snapshot changed during invalidation')
        return { ok: true, value: { invalidated: true } }
      }
      finally {
        writing = false
      }
    },
    async purge(request) {
      if (writing)
        return error('not-ready', 'A relation publication is in progress')
      if (!request.operationId.trim() || !request.nextManifestId.trim()
        || request.nextManifestId === current.manifest.manifestId)
        return error('invalid-request', 'Purge needs a new manifest ID and operation ID')
      if (request.expectedManifestId !== current.manifest.manifestId || !unchanged())
        return error('version-mismatch', 'Relation manifest changed')
      if (!sameScope(request.scope, current.manifest.scope))
        return error('scope-denied', 'Relation scope mismatch')
      if (request.sourceVersions.length + request.claimVersions.length === 0)
        return error('invalid-request', 'Purge needs at least one exact source or claim version')
      if (request.sourceVersions.some(source => !source.episodeId || !source.contentHash)
        || request.claimVersions.some(ref => ref.kind !== 'claim' || !ref.id || !Number.isSafeInteger(ref.version) || ref.version <= 0))
        return error('invalid-request', 'Purge target contains an invalid exact version')
      writing = true
      try {
        const { relations, candidates, observations, removed } = pruneGraphRelationDependencies(current, request, options.coreSnapshot().semanticBundle.claims)
        const next: GraphRelationSnapshot = {
          manifest: {
            ...current.manifest,
            manifestId: request.nextManifestId,
            relationRevision: current.manifest.relationRevision + Number(relations.length !== current.relations.length),
            candidateRevision: current.manifest.candidateRevision + Number(candidates.length !== current.candidates.length || observations.length !== current.observations.length),
            createdAt: Math.max(options.now?.() ?? Date.now(), current.manifest.createdAt),
            state: 'stale',
          },
          relations, candidates, observations,
        }
        if (!persist(next))
          return error('version-mismatch', 'Persisted relation snapshot changed during purge')
        return { ok: true, value: removed }
      }
      finally {
        writing = false
      }
    },
  }
}

export function createEmptyGraphRelationSnapshot(core: GraphProjectionSnapshot, createdAt: number): GraphRelationSnapshot {
  if (!Number.isSafeInteger(createdAt) || createdAt <= 0)
    throw new Error('Relation creation time must be positive')
  const snapshot: GraphRelationSnapshot = {
    manifest: {
      protocolVersion: MEMORY_GRAPH_PROTOCOL_VERSION,
      schemaVersion: GRAPH_RELATION_SCHEMA_VERSION,
      manifestId: `relation-empty:${core.manifest.manifestId}`,
      scope: core.manifest.scope,
      coreManifestId: core.manifest.manifestId,
      sourceBundleId: core.semanticBundle.bundleId,
      relationRevision: 0,
      candidateRevision: 0,
      createdAt,
      state: 'ready',
    },
    relations: [],
    candidates: [],
    observations: [],
  }
  assertGraphRelationSnapshot(snapshot, core)
  return snapshot
}

function parsePersisted(payload: string, core: GraphProjectionSnapshot): GraphRelationSnapshot {
  const snapshot = JSON.parse(payload) as GraphRelationSnapshot
  if (!snapshot?.manifest || snapshot.manifest.protocolVersion !== MEMORY_GRAPH_PROTOCOL_VERSION
    || snapshot.manifest.schemaVersion !== GRAPH_RELATION_SCHEMA_VERSION
    || !Array.isArray(snapshot.relations) || !Array.isArray(snapshot.candidates)
    || !Array.isArray(snapshot.observations))
    throw new Error('Persisted L2 relation snapshot has an invalid schema')
  // A changed L1 source is immediately unreadable. Reconciliation must explicitly
  // purge invalid exact references and publish a new ready snapshot.
  if (snapshot.manifest.coreManifestId === core.manifest.manifestId)
    assertGraphRelationSnapshot(snapshot, core)
  else if (snapshot.manifest.state === 'ready')
    return clone({ ...snapshot, manifest: { ...snapshot.manifest, state: 'stale' } })
  return clone(snapshot)
}

function assertPublishTransition(previous: GraphRelationSnapshot, next: GraphRelationSnapshot): void {
  if (next.manifest.state !== 'ready')
    throw new Error('Published relation snapshot must be ready')
  if (next.manifest.manifestId === previous.manifest.manifestId)
    throw new Error('Published relation manifest ID must change')
  if (next.manifest.createdAt < previous.manifest.createdAt)
    throw new Error('Relation manifest creation time moved backwards')
  const relationsChanged = JSON.stringify(next.relations) !== JSON.stringify(previous.relations)
  const candidatesChanged = JSON.stringify([next.candidates, next.observations]) !== JSON.stringify([previous.candidates, previous.observations])
  if (next.manifest.relationRevision !== previous.manifest.relationRevision + Number(relationsChanged))
    throw new Error('Relation revision does not match authoritative changes')
  if (next.manifest.candidateRevision !== previous.manifest.candidateRevision + Number(candidatesChanged))
    throw new Error('Candidate revision does not match staging changes')
  const nextByRef = new Map(next.relations.map(relation => [refKey(relation.ref), relation]))
  for (const old of previous.relations) {
    const newer = nextByRef.get(refKey(old.ref))
    if (!newer)
      throw new Error('Existing relation version was removed without a purge')
    const allowedClosure = old.transactionTime.closedAt === null && newer.transactionTime.closedAt !== null
      ? { ...old, transactionTime: { ...old.transactionTime, closedAt: newer.transactionTime.closedAt } }
      : old
    if (JSON.stringify(allowedClosure) !== JSON.stringify(newer))
      throw new Error('Existing relation version was rewritten')
  }
  const nextObservations = new Map(next.observations.map(item => [item.id, item]))
  for (const old of previous.observations) {
    if (JSON.stringify(old) !== JSON.stringify(nextObservations.get(old.id)))
      throw new Error('Existing NLI observation was removed or rewritten')
  }
  const nextCandidates = new Map(next.candidates.map(item => [item.id, item]))
  for (const old of previous.candidates) {
    const newer = nextCandidates.get(old.id)
    if (!newer)
      throw new Error('Existing candidate was removed without a purge')
    if (JSON.stringify({ ...old, resolution: newer.resolution }) !== JSON.stringify(newer))
      throw new Error('Existing candidate content was rewritten')
    if (old.resolution.status !== 'pending' && JSON.stringify(old.resolution) !== JSON.stringify(newer.resolution))
      throw new Error('Resolved candidate decision was rewritten')
  }
}

function gatherSources(snapshot: GraphRelationSnapshot): readonly GraphSourceRef[] {
  const refs = new Map<string, GraphSourceRef>()
  function add(ref: GraphSourceRef): void {
    refs.set(`${ref.episodeId}\u0000${ref.contentHash}\u0000${JSON.stringify(ref.locator)}`, ref)
  }
  for (const relation of snapshot.relations) {
    relation.provenance.sources.forEach(add)
    relation.evidence.forEach(item => add(item.source))
  }
  for (const candidate of snapshot.candidates)
    candidate.sourceHints.forEach(add)
  for (const observation of snapshot.observations) {
    if (observation.premise.kind === 'source')
      add(observation.premise.ref)
  }
  return [...refs.values()]
}

function sameScope(a: GraphScope, b: GraphScope): boolean {
  return a.ownerId === b.ownerId && a.agentId === b.agentId && a.sessionId === b.sessionId
}

function refKey(ref: { kind: string; id: string; version: number }): string {
  return `${ref.kind}\u0000${ref.id}\u0000${ref.version}`
}


function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'Invalid relation snapshot'
}

function error(code: 'invalid-request' | 'version-mismatch' | 'scope-denied' | 'not-ready' | 'stale-projection' | 'source-unavailable', description: string): GraphResult<never> {
  return { ok: false, error: { code, message: description } }
}
