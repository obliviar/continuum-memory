/** Internal recall projection and legacy test data. Never publish this shape as an L2 snapshot. */
import type { GraphClaimRef, GraphContextRef, GraphRelationRef, GraphSupportState, GraphTimeExtent, NonEmptyReadonlyArray, GraphSourceRef } from '@continuum-memory/contracts'
import type { GraphSemanticRecord, GraphSemanticBundle, GraphEdge } from './types'
import type { GraphRelationKind as AuthoritativeRelationKind, GraphRelationRecord as AuthoritativeRelationRecord } from './relation-types'

export type GraphRecallRelationKind =
  | AuthoritativeRelationKind
  | 'causal'
  | 'contributes-to'
  | 'before'

export interface GraphRecallRelationRecord extends GraphSemanticRecord {
  /** Present only when read through the authoritative, version-pinned L2 adapter. */
  readonly authoritativeRecord?: AuthoritativeRelationRecord
  readonly ref: GraphRelationRef
  readonly from: GraphClaimRef
  readonly to: GraphClaimRef
  readonly kind: GraphRecallRelationKind

  readonly context: GraphContextRef
  readonly validTime: GraphTimeExtent

  readonly assertion: 'explicit-claim' | 'hypothesis'
  readonly status: 'active' | 'revoked'
  readonly support: GraphSupportState

  readonly evidence: NonEmptyReadonlyArray<{
    readonly source: GraphSourceRef
    readonly role: 'supports' | 'refutes' | 'references'
  }>
}

/** Only the synthetic in-memory fixture uses a combined L1/L2 container. */
export interface GraphRecallFixtureBundle extends GraphSemanticBundle {
  readonly revisions: GraphSemanticBundle['revisions'] & { readonly relations: number }
  readonly relations: readonly GraphRecallRelationRecord[]
}
export type GraphRecallRelationEdge = { readonly id: string; readonly layer: 'semantic'; readonly kind: GraphRecallRelationKind;
  readonly from: GraphClaimRef; readonly to: GraphClaimRef; readonly relationRef: GraphRelationRef }
export type GraphRecallEdge = GraphEdge | GraphRecallRelationEdge
export const RECALL_RELATION_KINDS: readonly GraphRecallRelationKind[] = ['causal', 'contributes-to', 'before', 'causes', 'precedes', 'explains', 'entails', 'contradicts']
