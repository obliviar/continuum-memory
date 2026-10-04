import type { GraphClaimRef } from '@continuum-memory/contracts'
import type { GraphRelationEdge } from '../domain/relation-types'

/** Rebuild once per pinned snapshot. Neighbor reads visit only exact-version incident edges. */
export function createL2AdjacencyIndex(edges: readonly GraphRelationEdge[]) {
  const incident = new Map<string, GraphRelationEdge[]>()
  const key = (ref: GraphClaimRef) => JSON.stringify([ref.kind, ref.id, ref.version])
  for (const edge of edges) for (const id of new Set([key(edge.from), key(edge.to)])) {
    const list = incident.get(id) ?? []; list.push(edge); incident.set(id, list)
  }
  for (const list of incident.values()) list.sort((a, b) => a.id.localeCompare(b.id))
  return { candidates: (ref: GraphClaimRef): readonly GraphRelationEdge[] => incident.get(key(ref)) ?? [] }
}
