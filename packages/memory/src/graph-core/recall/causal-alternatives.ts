import type { GraphClaimRef, GraphRelationRef } from '@continuum-memory/contracts'
import type { GraphClaimRecord,  } from '../domain/types'
import type { GraphRecallRelationKind as GraphRelationKind, GraphRecallRelationRecord as GraphRelationRecord } from '../domain/recall-types'
import { claimConflictKey } from '../domain/claim-conflicts'
import type { GraphRecallNeighborQuery as GraphNeighborQuery } from '../ports/graph-recall-ports'

export interface GraphCausalAlternativeCheck {
  readonly target: GraphClaimRef
  readonly coverage: 'complete-within-declared-scope' | 'incomplete' | 'not-checked'
  readonly kinds: readonly GraphRelationKind[]
  /** Multiple causes may coexist. Different source records for the same cause form one group. */
  readonly causes: readonly { readonly claims: readonly GraphClaimRef[]; readonly relations: readonly GraphRelationRef[] }[]
  readonly hasMultipleCauses: boolean
  readonly interpretation: 'candidates-may-coexist'
}

/** Summarize already-read direct causes; never invent exclusivity or scan outside the declared traversal. */
export function summarizeCausalAlternatives(
  targets: readonly GraphClaimRecord[], relations: readonly GraphRelationRecord[],
  direction: GraphNeighborQuery['direction'], kinds: readonly GraphRelationKind[],
  started: ReadonlySet<string>, completed: ReadonlySet<string>,
): GraphCausalAlternativeCheck[] {
  const records = new Map(targets.map(record => [refKey(record.ref), record]))
  const causeKinds = kinds.filter(kind => kind === 'causal' || kind === 'contributes-to' || kind === 'causes')
  return targets.map(target => {
    const key = refKey(target.ref)
    const eligible = direction !== 'out' && causeKinds.length > 0
    const groups = new Map<string, { claims: Map<string, GraphClaimRef>; relations: GraphRelationRef[] }>()
    for (const relation of relations) {
      if (refKey(relation.to) !== key || !causeKinds.some(kind => kind === relation.kind)) continue
      const cause = records.get(refKey(relation.from))!
      // Exact statement/time grouping only; distinct paraphrases require later normalization.
      const causeKey = JSON.stringify([claimConflictKey(cause), cause.polarity, cause.validTime.kind,
        ...(cause.validTime.kind === 'interval' ? [cause.validTime.from, cause.validTime.to] : [])])
      const group = groups.get(causeKey) ?? { claims: new Map<string, GraphClaimRef>(), relations: [] }
      group.claims.set(refKey(cause.ref), cause.ref)
      group.relations.push(relation.ref)
      groups.set(causeKey, group)
    }
    return { target: target.ref,
      coverage: eligible && completed.has(key) ? 'complete-within-declared-scope'
        : eligible && started.has(key) ? 'incomplete' : 'not-checked',
      kinds: causeKinds,
      causes: [...groups.values()].map(group => ({ claims: [...group.claims.values()], relations: group.relations })),
      hasMultipleCauses: groups.size > 1, interpretation: 'candidates-may-coexist',
    }
  })
}
function refKey(ref: GraphClaimRef): string { return JSON.stringify([ref.kind, ref.id, ref.version]) }
