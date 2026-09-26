import type { GraphClaimRef } from '@continuum-memory/contracts'
import type { GraphClaimRecord } from './types'

export interface GraphRelationPairSeed {
  readonly from: GraphClaimRef
  readonly to: GraphClaimRef
  /** A retrieval route is a reason to compare, not a relation assertion. */
  readonly route: 'source-cue' | 'structured' | 'dense' | 'relation-neighbor'
}

export interface GraphRelationPairInput {
  readonly source: GraphClaimRecord
  readonly sourceCue: readonly GraphClaimRecord[]
  readonly structured: readonly GraphClaimRecord[]
  readonly dense: readonly GraphClaimRecord[]
  /** Only already accepted one-hop L2 neighbors of dense seeds belong here. */
  readonly neighbors: readonly { readonly seed: GraphClaimRef; readonly related: GraphClaimRecord }[]
  readonly maxCandidates: number
  readonly maxDenseSeeds: number
}

/** Bounded candidate routing; relation kind and hypothesis text are determined later from evidence. */
export function selectGraphRelationPairSeeds(input: GraphRelationPairInput): readonly GraphRelationPairSeed[] {
  if (!Number.isSafeInteger(input.maxCandidates) || input.maxCandidates < 0
    || !Number.isSafeInteger(input.maxDenseSeeds) || input.maxDenseSeeds < 0)
    throw new Error('Relation candidate budgets must be nonnegative integers')
  if (input.source.review.status !== 'accepted' || input.source.transactionTime.closedAt !== null)
    return []
  const selected = new Map<string, GraphRelationPairSeed>()
  const denseSeeds = new Set<string>()

  function eligible(claim: GraphClaimRecord): boolean {
    return refKey(claim.ref) !== refKey(input.source.ref)
      && claim.review.status === 'accepted' && claim.transactionTime.closedAt === null
      && sameScope(claim, input.source)
      && refKey(claim.context) === refKey(input.source.context)
  }

  function add(claim: GraphClaimRecord, route: GraphRelationPairSeed['route']): boolean {
    if (selected.size >= input.maxCandidates || !eligible(claim))
      return false
    const key = refKey(claim.ref)
    if (selected.has(key))
      return false
    selected.set(key, { from: input.source.ref, to: claim.ref, route })
    return true
  }

  // Source discourse and exact keys protect recall when semantically related clauses are far apart in vector space.
  for (const claim of input.sourceCue)
    add(claim, 'source-cue')
  for (const claim of input.structured)
    add(claim, 'structured')
  for (const claim of input.dense) {
    if (denseSeeds.size >= input.maxDenseSeeds)
      break
    if (eligible(claim)) {
      denseSeeds.add(refKey(claim.ref))
      add(claim, 'dense')
    }
  }
  for (const neighbor of input.neighbors) {
    if (denseSeeds.has(refKey(neighbor.seed)))
      add(neighbor.related, 'relation-neighbor')
  }
  for (const claim of input.dense)
    add(claim, 'dense')
  return [...selected.values()]
}

function sameScope(a: GraphClaimRecord, b: GraphClaimRecord): boolean {
  return a.scope.ownerId === b.scope.ownerId
    && a.scope.agentId === b.scope.agentId
    && a.scope.sessionId === b.scope.sessionId
}

function refKey(ref: { kind: string; id: string; version: number }): string {
  return `${ref.kind}\u0000${ref.id}\u0000${ref.version}`
}
