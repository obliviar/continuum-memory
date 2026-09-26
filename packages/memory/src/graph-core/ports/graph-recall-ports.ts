import type { GraphAnswerRef, GraphClaimRef, GraphEntityRef, GraphFactRef, GraphRelationRef, GraphRecallRequest, GraphResult, GraphSourceRef } from '@continuum-memory/contracts'
import type { GraphRelationManifest } from '../domain/relation-types'
import type { GraphRecallEdge, GraphRecallRelationRecord } from '../domain/recall-types'
import type { GraphOpenViewRequest, GraphReadView, GraphNeighborQuery, GraphPage, GraphSourceContent } from './graph-ports'
export * from './graph-ports'

export interface GraphRecallOpenViewRequest extends GraphOpenViewRequest {
  readonly expectedRelationManifestId?: string
}
export interface GraphRecallNeighborQuery extends Omit<GraphNeighborQuery, 'kinds'> {
  readonly kinds: readonly GraphRecallEdge['kind'][]
}
export interface GraphRecallReadView extends Omit<GraphReadView, 'neighbors' | 'context'> {
  readonly context: GraphRecallOpenViewRequest
  readonly relationManifest?: GraphRelationManifest
  neighbors: (query: GraphRecallNeighborQuery) => Promise<GraphResult<GraphPage<GraphRecallEdge>>>
  resolveRelations: (refs: readonly GraphRelationRef[]) => Promise<GraphResult<readonly GraphRecallRelationRecord[]>>
}
export interface GraphRecallReadPort {
  openView: (request: GraphRecallOpenViewRequest) => Promise<GraphResult<GraphRecallReadView>>
}
export interface GraphRecallEvidenceReader {
  readSources: (view: GraphRecallReadView, refs: readonly GraphSourceRef[]) => Promise<GraphResult<readonly GraphSourceContent[]>>
  resolveFactVersions: (view: GraphRecallReadView, refs: readonly GraphFactRef[]) => Promise<GraphResult<readonly {
    readonly ref: GraphFactRef; readonly canonicalText: string; readonly sources: readonly GraphSourceRef[]
  }[]>>
}

export interface GraphSeedEntries {
  /** Host-resolved exact entry references; identities are still checked in the view. */
  readonly claims?: readonly GraphClaimRef[]
  readonly entities?: readonly GraphEntityRef[]
  readonly relations?: readonly GraphRelationRef[]
}
export type GraphSeedOrigin =
  | { readonly kind: 'claim-text' | 'claim-ref'; readonly ref: GraphClaimRef }
  | { readonly kind: 'entity-ref'; readonly ref: GraphEntityRef }
  | { readonly kind: 'relation-ref'; readonly ref: GraphRelationRef }
export interface GraphSeedCandidate {
  readonly ref: GraphAnswerRef
  readonly route: 'lexical' | 'dense' | 'structured' | 'summary'
  readonly relevance: number
  /** Optional for existing adapters. Origins locate candidates; they are not evidence certificates. */
  readonly origins?: readonly GraphSeedOrigin[]
}
export interface GraphSeedSearchRequest extends GraphRecallRequest {
  /** Exact host-resolved entities; every one must occur in the seed Claim's arguments. */
  readonly entities?: readonly GraphEntityRef[]
  readonly entries?: GraphSeedEntries
  /** Determines which endpoint of a relation is a candidate target. */
  readonly traversal?: { readonly direction: 'in' | 'out' | 'both'; readonly kinds: readonly GraphRecallRelationRecord['kind'][] }
}

export interface GraphRecallSeedPort {
  /**
   * The local lexical adapter computes up to budget.maxSeeds over its eligible
   * corpus. complete means this bounded top-K search finished, not all matching
   * claims were returned. It has no cursor input: it never returns more and
   * reports budget-exhausted with no candidates if its corpus scan is truncated.
   */
  search: (request: GraphSeedSearchRequest, view: GraphRecallReadView) => Promise<GraphResult<GraphPage<GraphSeedCandidate>>>
}
