import { createHash } from 'node:crypto'
import type { GraphClaimRef, GraphResult } from '@continuum-memory/contracts'
import type { GraphClaimRecord, GraphProjectionSnapshot } from '../domain/types'
import type { GraphRelationRepository } from './relation-repository'

/** Rebinds an L2 snapshot only after invalid exact L1 endpoints have been purged. */
export async function rebaseGraphRelations(input: {
  readonly repository: GraphRelationRepository
  readonly core: GraphProjectionSnapshot
  readonly now?: () => number
}): Promise<GraphResult<{ readonly manifestId: string; readonly purgedClaims: number }>> {
  const { repository, core } = input
  if (core.manifest.state !== 'ready')
    return failure('stale-projection', 'L1 view is not ready')
  let current = repository.snapshot()
  if (!sameScope(current.manifest.scope, core.manifest.scope))
    return failure('scope-denied', 'L1 and L2 scopes differ')
  if (current.manifest.state === 'ready' && current.manifest.coreManifestId === core.manifest.manifestId
    && current.manifest.sourceBundleId === core.semanticBundle.bundleId)
    return { ok: true, value: { manifestId: current.manifest.manifestId, purgedClaims: 0 } }
  if (current.manifest.state === 'ready') {
    const id = nextId('l2-stale', current.manifest.manifestId, core.manifest.manifestId)
    const invalidated = await repository.invalidate({ operationId: id, scope: current.manifest.scope,
      expectedManifestId: current.manifest.manifestId, nextManifestId: id, reason: 'core-changed' })
    if (!invalidated.ok) return invalidated
    current = repository.snapshot()
  }
  const live = new Map(core.semanticBundle.claims.map(claim => [key(claim.ref), claim]))
  const contexts = new Set(core.semanticBundle.contexts.map(context => key(context.ref)))
  const invalid = new Map<string, GraphClaimRef>()
  const check = (ref: GraphClaimRef, context: { kind: string; id: string; version: number }): void => {
    const claim = live.get(key(ref))
    if (!claim || !endpointMatches(claim, context, contexts, core)) invalid.set(key(ref), ref)
  }
  for (const candidate of current.candidates) {
    check(candidate.from, candidate.context)
    check(candidate.to, candidate.context)
  }
  for (const relation of current.relations) {
    check(relation.from, relation.context)
    check(relation.to, relation.context)
  }
  // Observations without a candidate are invalid persisted data; publication will reject them.
  if (invalid.size) {
    const id = nextId('l2-purge', current.manifest.manifestId, [...invalid.keys()])
    const purged = await repository.purge({ operationId: id, scope: current.manifest.scope,
      expectedManifestId: current.manifest.manifestId, nextManifestId: id,
      sourceVersions: [], claimVersions: [...invalid.values()] })
    if (!purged.ok) return purged
    current = repository.snapshot()
  }
  const at = input.now?.() ?? Date.now()
  if (!Number.isSafeInteger(at) || at <= 0)
    return failure('invalid-request', 'Invalid L2 publication time')
  const id = nextId('l2-rebase', current.manifest.manifestId, core.manifest.manifestId)
  const next = { ...current, manifest: { ...current.manifest, manifestId: id,
    coreManifestId: core.manifest.manifestId, sourceBundleId: core.semanticBundle.bundleId,
    createdAt: Math.max(at, current.manifest.createdAt), state: 'ready' as const } }
  const published = await repository.publish({ operationId: id,
    expectedManifestId: current.manifest.manifestId, snapshot: next })
  return published.ok ? { ok: true, value: { manifestId: published.value.manifestId,
    purgedClaims: invalid.size } } : published
}

function endpointMatches(claim: GraphClaimRecord,
  context: { kind: string; id: string; version: number }, contexts: ReadonlySet<string>,
  core: GraphProjectionSnapshot): boolean {
  return claim.review.status === 'accepted' && claim.transactionTime.closedAt === null
    && key(claim.context) === key(context) && contexts.has(key(context))
    && sameScope(claim.scope, core.manifest.scope)
}

function sameScope(a: GraphProjectionSnapshot['manifest']['scope'],
  b: GraphProjectionSnapshot['manifest']['scope']): boolean {
  return a.ownerId === b.ownerId && a.agentId === b.agentId && a.sessionId === b.sessionId
}

function key(ref: { kind: string; id: string; version: number }): string {
  return `${ref.kind}\0${ref.id}\0${ref.version}`
}

function nextId(prefix: string, ...values: unknown[]): string {
  return `${prefix}:${createHash('sha256').update(JSON.stringify(values)).digest('hex')}`
}

function failure(code: 'invalid-request' | 'scope-denied' | 'stale-projection', message: string): GraphResult<never> {
  return { ok: false, error: { code, message } }
}
