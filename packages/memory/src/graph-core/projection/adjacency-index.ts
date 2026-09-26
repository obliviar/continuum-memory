import type { GraphClaimRef, GraphRelationRef } from '@continuum-memory/contracts'
import type { GraphRecallRelationKind as GraphRelationKind, GraphRecallEdge as GraphEdge } from '../domain/recall-types'

type GraphRecallRelationEdge = Extract<GraphEdge, { readonly relationRef: GraphRelationRef }>

/* Derived index only. Eligibility and source checks belong to the read view. */
export function createRelationAdjacencyIndex(edges: readonly GraphEdge[]) {
  const outgoing = new Map<string, GraphRecallRelationEdge[]>()
  const incoming = new Map<string, GraphRecallRelationEdge[]>()
  for (const edge of structuredClone(edges)) {
    if (edge.layer !== 'semantic' || !('relationRef' in edge))
      continue
    append(outgoing, key(edge.from), edge)
    append(incoming, key(edge.to), edge)
  }
  return {
    candidates(node: GraphClaimRef, direction: 'out' | 'in' | 'both', kinds: readonly GraphRelationKind[]): readonly GraphRecallRelationEdge[] {
      const candidates = [
        ...(direction === 'in' ? [] : outgoing.get(key(node)) ?? []),
        ...(direction === 'out' ? [] : incoming.get(key(node)) ?? []),
      ]
      const allowed = new Set(kinds)
      // An edge can appear in both lists for a self-loop. Return it only once.
      const unique = new Map(candidates.filter(edge => allowed.has(edge.kind)).map(edge => [edge.id, edge]))
      return structuredClone([...unique.values()].sort((a, b) => a.id.localeCompare(b.id)))
    },
  }
}

function key(ref: GraphClaimRef): string {
  return JSON.stringify([ref.kind, ref.id, ref.version])
}

function append(index: Map<string, GraphRecallRelationEdge[]>, id: string, edge: GraphRecallRelationEdge): void {
  const items = index.get(id) ?? []
  items.push(edge)
  index.set(id, items)
}
