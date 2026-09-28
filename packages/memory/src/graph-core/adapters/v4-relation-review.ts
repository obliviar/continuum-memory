import { randomUUID } from 'node:crypto'
import type { GraphClaimRef, GraphProtocolErrorCode, GraphResult, GraphScope, GraphSourceRef } from '@continuum-memory/contracts'
import type { GraphRelationSnapshot } from '../domain/relation-types'
import { assertGraphRelationSnapshot } from '../domain/relation-core'
import type { GraphRelationRepository, GraphRelationPersistence } from '../repository/relation-repository'
import type { V4L1Store } from '../repository/v4-l1-store'
import type { V4GraphMemoryOptions } from './v4-graph-memory'
import { createV4RelationSourceReader } from './v4-relation-sources'
import { graphHash } from './v4-semantic-adapter'

type Prepared = { core: { l1: V4L1Store }; repository: GraphRelationRepository }
type Options = V4GraphMemoryOptions & {
  relationPersistence: GraphRelationPersistence
  prepare: (scope: GraphScope) => GraphResult<Prepared>
}
export interface V4RelationReviewReport {
  readonly reviewId: string | null
  readonly expiresAt: number | null
  readonly scope: GraphScope
  readonly previousManifestId: string
  readonly targetCoreManifestId: string
  readonly canPublish: boolean
  readonly relations: readonly { id: string; kind: string; from: GraphClaimRef; to: GraphClaimRef;
    fromText: string | null; toText: string | null; eligible: boolean; reasons: readonly string[] }[]
  readonly candidateCount: number
  readonly observationCount: number
  readonly blockers: readonly string[]
}
const fail = (code: GraphProtocolErrorCode, message: string): GraphResult<never> => ({ ok: false, error: { code, message } })

/** Trusted host only. Technical revalidation never chooses replacement endpoints or promotes candidates.
 * Preview prepares current L1 but does not publish ready L2. Publish requires a server-held preview token.
 */
export function createV4RelationReview(options: Options) {
  const now = options.now ?? Date.now, sources = createV4RelationSourceReader(options)
  const pending = new Map<string, { scope: GraphScope; expiresAt: number; checkpoint: string | undefined;
    prepared: Prepared; next: GraphRelationSnapshot }>()
  async function reviewRelations(scope: GraphScope): Promise<GraphResult<V4RelationReviewReport>> {
    try {
      scope = structuredClone(scope)
      if (!options.authorizeScope(scope)) return fail('scope-denied', 'Review scope denied')
      for (const [id, item] of pending) if (item.expiresAt <= now()) pending.delete(id)
      const prepared = options.prepare(scope); if (!prepared.ok) return prepared
      const { core, repository } = prepared.value, projection = core.l1.snapshot()!
      const current = repository.snapshot(), checkpoint = options.relationPersistence.load()
      if (graphHash(current.manifest.scope) !== graphHash(scope)) return fail('scope-denied', 'Review requires the exact relation scope')
      if (current.relations.length + current.candidates.length + current.observations.length > 500)
        return fail('budget-exhausted', 'Review supports at most 500 records per snapshot')
      const next: GraphRelationSnapshot = { ...current, manifest: { ...current.manifest,
        manifestId: `reviewed:${randomUUID()}`, coreManifestId: projection.manifest.manifestId,
        sourceBundleId: projection.semanticBundle.bundleId, createdAt: Math.max(now(), current.manifest.createdAt), state: 'ready' } }
      const blockers: string[] = [], relations: V4RelationReviewReport['relations'][number][] = []
      const endpoints = new Set(projection.semanticBundle.claims.map(c => graphHash(c.ref)))
      const facts = new Map(options.repository.snapshot().facts.map(fact => [fact.id, fact.canonicalText]))
      const labels = new Map(projection.semanticBundle.claims.map(claim => [graphHash(claim.ref), facts.get(claim.fact.id) ?? null]))
      const refs: GraphSourceRef[] = []
      for (const relation of current.relations) {
        const reasons: string[] = []
        if (!endpoints.has(graphHash(relation.from)) || !endpoints.has(graphHash(relation.to))) reasons.push('exact-endpoint-unavailable')
        const sourceRefs = [...relation.provenance.sources, ...relation.evidence.map(e => e.source)]
        const verified = await sources.verify(sourceRefs, scope, [relation])
        if (!verified.ok) reasons.push(verified.error.code)
        refs.push(...sourceRefs)
        relations.push({ id: relation.ref.id, kind: relation.kind, from: relation.from, to: relation.to,
          fromText: labels.get(graphHash(relation.from)) ?? null, toText: labels.get(graphHash(relation.to)) ?? null,
          eligible: reasons.length === 0, reasons })
        if (reasons.length) blockers.push(`relation:${relation.ref.id}:${reasons.join(',')}`)
      }
      for (const candidate of current.candidates) refs.push(...candidate.sourceHints)
      for (const observation of current.observations) if (observation.premise.kind === 'source') refs.push(observation.premise.ref)
      const verified = await sources.verify(refs, scope, current.relations)
      if (!verified.ok) blockers.push(`sources:${verified.error.code}`)
      try { assertGraphRelationSnapshot(next, projection) }
      catch (error) { blockers.push(`structure:${error instanceof Error ? error.message : 'invalid snapshot'}`) }
      if (!options.authorizeScope(scope)) return fail('scope-denied', 'Review authorization changed')
      const live = core.l1.snapshot()
      if (live?.manifest.state !== 'ready' || live.manifest.manifestId !== projection.manifest.manifestId
        || options.relationPersistence.load() !== checkpoint) return fail('version-mismatch', 'Sources or relations changed during review')
      const canPublish = blockers.length === 0 && relations.every(r => r.eligible)
      const reviewId = canPublish ? randomUUID() : null, expiresAt = canPublish ? now() + 300_000 : null
      if (reviewId) {
        if (pending.size >= 32) pending.delete(pending.keys().next().value!)
        pending.set(reviewId, { scope: structuredClone(scope), expiresAt: expiresAt!, checkpoint, prepared: prepared.value, next: structuredClone(next) })
      }
      return { ok: true, value: structuredClone({ reviewId, expiresAt, scope, previousManifestId: current.manifest.manifestId,
        targetCoreManifestId: projection.manifest.manifestId, canPublish, relations,
        candidateCount: current.candidates.length, observationCount: current.observations.length, blockers }) }
    } catch { return fail('not-ready', 'Relation review could not read or prepare current snapshots') }
  }
  async function republishRelations(request: { reviewId: string; scope: GraphScope; operationId: string; reviewer: string; reason: string }) {
    try {
      if (!options.authorizeScope(request.scope)) return fail('scope-denied', 'Review scope denied')
      if (!request.operationId?.trim() || !request.reviewer?.trim() || !request.reason?.trim()
        || request.operationId.length > 200 || request.reviewer.length > 200 || request.reason.length > 2000)
        return fail('invalid-request', 'An explicit operation ID, reviewer and reason are required')
      const item = pending.get(request.reviewId)
      if (!item || item.expiresAt <= now()) { pending.delete(request.reviewId); return fail('invalid-request', 'Review expired or unknown; prepare a fresh report') }
      if (graphHash(item.scope) !== graphHash(request.scope)) return fail('scope-denied', 'Review token belongs to another scope')
      // Consume before awaiting publication: one token cannot launch concurrent or repeated writes.
      pending.delete(request.reviewId)
      const live = item.prepared.core.l1.snapshot()
      if (options.relationPersistence.load() !== item.checkpoint || live?.manifest.state !== 'ready'
        || live.manifest.manifestId !== item.next.manifest.coreManifestId)
        return fail('version-mismatch', 'Review inputs changed; prepare a fresh report')
      const previous = item.prepared.repository.snapshot(), reviewedAt = now()
      const next: GraphRelationSnapshot = { ...item.next, manifest: { ...item.next.manifest,
        createdAt: Math.max(reviewedAt, item.next.manifest.createdAt) }, lastRevalidation: {
        operationId: request.operationId, reviewer: request.reviewer.trim(), reason: request.reason.trim(), reviewedAt,
        previousManifestId: previous.manifest.manifestId, previousCoreManifestId: previous.manifest.coreManifestId,
        targetCoreManifestId: item.next.manifest.coreManifestId } }
      return await item.prepared.repository.publish({ operationId: request.operationId,
        expectedManifestId: previous.manifest.manifestId, snapshot: next })
    } catch { return fail('not-ready', 'Relation republication failed; prepare a fresh report before retrying') }
  }
  return { reviewRelations, republishRelations }
}
