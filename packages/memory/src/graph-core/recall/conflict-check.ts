import type { GraphClaimRef, GraphResult, GraphTemporalQuery } from '@continuum-memory/contracts'
import type { GraphClaimRecord } from '../domain/types'
import { areOppositeClaims, EXACT_CONFLICT_POLICY } from '../domain/claim-conflicts'
import type { GraphRecallReadView as GraphReadView } from '../ports/graph-recall-ports'

export interface GraphConflictAudit {
  readonly policy: typeof EXACT_CONFLICT_POLICY
  readonly status: 'not-performed' | 'complete-within-policy' | 'incomplete' | 'unsupported'
  readonly reason: 'checked' | 'budget-exhausted' | 'unsupported' | 'compatibility-mode'
  readonly scanned: number
  /** Fixed traversal targets, NOT recursively extended by discovered opposing claims. */
  readonly targets: readonly {
    readonly claim: GraphClaimRef
    readonly status: 'complete' | 'incomplete' | 'not-started'
  }[]
  /** Both endpoints have exact facts and source evidence in the recall result. */
  readonly pairs: readonly { readonly claim: GraphClaimRef; readonly opposing: GraphClaimRef; readonly kind: 'opposite-polarity' }[]
}

export function unperformedConflictAudit(): GraphConflictAudit {
  return { policy: EXACT_CONFLICT_POLICY, status: 'not-performed', reason: 'compatibility-mode', scanned: 0, targets: [], pairs: [] }
}

/** A bounded evidence audit; it neither changes stored support nor chooses which claim is true. */
export async function checkClaimConflicts(
  view: GraphReadView,
  targets: readonly GraphClaimRecord[],
  temporal: GraphTemporalQuery,
  loadEvidence: (ref: GraphClaimRef) => Promise<GraphResult<GraphClaimRecord>>,
): Promise<GraphResult<GraphConflictAudit>> {
  const progress = targets.map(claim => ({ claim: claim.ref, status: 'not-started' as 'complete' | 'incomplete' | 'not-started' }))
  const pairs: Array<GraphConflictAudit['pairs'][number]> = []
  const pairKeys = new Set<string>()
  let scanned = 0
  const finish = (status: GraphConflictAudit['status'], reason: GraphConflictAudit['reason']): GraphResult<GraphConflictAudit> =>
    ({ ok: true, value: { policy: EXACT_CONFLICT_POLICY, status, reason, scanned, targets: progress, pairs } })
  if (view.conflictPolicy !== EXACT_CONFLICT_POLICY) return finish('unsupported', 'unsupported')
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i]!
    progress[i]!.status = 'incomplete'
    let cursor: string | undefined
    const cursors = new Set<string>()
    const seen = new Set<string>()
    while (true) {
      // Independent safety ceiling also bounds a third-party adapter's pagination.
      if (scanned >= 10000) return finish('incomplete', 'budget-exhausted')
      const pageLimit = Math.min(64, 10000 - scanned)
      const read = await view.findConflicts(target.ref, { limit: 1, maxScanned: pageLimit, ...(cursor ? { cursor } : {}) })
      if (!read.ok) {
        if (read.error.code === 'unsupported-capability') return finish('incomplete', 'unsupported')
        if (read.error.code === 'budget-exhausted') return finish('incomplete', 'budget-exhausted')
        return read
      }
      const page = read.value
      if (!Number.isSafeInteger(page.scanned) || page.scanned < 0 || page.scanned > pageLimit
        || page.items.length > 1 || page.items.length > page.scanned)
        return invalid('Conflict reader returned an invalid page')
      scanned += page.scanned
      for (const candidate of page.items) {
        const key = refKey(candidate.ref)
        if (seen.has(key) || !areOppositeClaims(target, candidate, temporal))
          return invalid('Conflict reader returned a duplicate or non-conflicting claim')
        seen.add(key)
        const loaded = await loadEvidence(candidate.ref)
        if (!loaded.ok) {
          if (loaded.error.code === 'budget-exhausted') return finish('incomplete', 'budget-exhausted')
          return loaded
        }
        if (refKey(loaded.value.ref) !== key || !areOppositeClaims(target, loaded.value, temporal))
          return invalid('Conflict candidate does not match its exact hydrated claim')
        const pairKey = JSON.stringify([refKey(target.ref), key].sort())
        if (!pairKeys.has(pairKey)) {
          pairKeys.add(pairKey)
          pairs.push({ claim: target.ref, opposing: loaded.value.ref, kind: 'opposite-polarity' })
        }
      }
      if (page.completion === 'budget-exhausted') return finish('incomplete', 'budget-exhausted')
      if (page.completion === 'complete') { progress[i]!.status = 'complete'; break }
      if (page.scanned === 0 || !page.nextCursor || cursors.has(page.nextCursor))
        return invalid('Conflict pagination did not make progress')
      cursors.add(page.nextCursor)
      cursor = page.nextCursor
    }
  }
  return finish('complete-within-policy', 'checked')
}

function refKey(ref: GraphClaimRef): string { return JSON.stringify([ref.kind, ref.id, ref.version]) }
function invalid(message: string): GraphResult<never> { return { ok: false, error: { code: 'invalid-request', message } } }
