import type { GraphTemporalQuery } from '@continuum-memory/contracts'
import type { GraphClaimRecord, GraphGroundTerm } from './types'

export const EXACT_CONFLICT_POLICY = 'exact-opposite-polarity-v1' as const

function termKey(term: GraphGroundTerm): unknown {
  if (term.kind === 'entity') return ['entity', term.ref.kind, term.ref.id, term.ref.version]
  if (term.kind === 'number') return ['number', term.value, term.unit ?? null]
  return [term.kind, term.value]
}

/** Exact structured identity only: no synonym matching, alias merging or value inference. */
export function claimConflictKey(claim: GraphClaimRecord): string {
  return JSON.stringify([
    claim.scope.ownerId, claim.scope.agentId, claim.scope.sessionId ?? null,
    claim.context.kind, claim.context.id, claim.context.version,
    claim.atom.predicate,
    Object.keys(claim.atom.args).sort().map(role => [role, termKey(claim.atom.args[role]!)]),
  ])
}

/** The two claims AND the requested valid-time interval must have a common instant. */
export function areOppositeClaims(a: GraphClaimRecord, b: GraphClaimRecord, temporal: GraphTemporalQuery): boolean {
  if (!((a.polarity === 'positive' && b.polarity === 'negative')
    || (a.polarity === 'negative' && b.polarity === 'positive'))
    || a.modality !== 'asserted' || b.modality !== 'asserted'
    || a.condition.kind !== 'none' || b.condition.kind !== 'none'
    || claimConflictKey(a) !== claimConflictKey(b)
    || a.validTime.kind !== 'interval' || b.validTime.kind !== 'interval') return false
  const start = Math.max(a.validTime.from ?? -Infinity, b.validTime.from ?? -Infinity)
  const end = Math.min(a.validTime.to ?? Infinity, b.validTime.to ?? Infinity)
  return temporal.valid.kind === 'at'
    ? start <= temporal.valid.at && temporal.valid.at < end
    : Math.max(start, temporal.valid.from) < Math.min(end, temporal.valid.to)
}
