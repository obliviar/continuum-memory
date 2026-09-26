import type {
  GraphClaimRef,
  GraphContextRef,
  GraphModality,
  GraphPolarity,
  GraphProtocolVersion,
  GraphRelationRef,
  GraphScope,
  GraphSourceRef,
  GraphTimeExtent,
  MemorySensitivity,
  MemorySharePolicy,
  NonEmptyReadonlyArray,
} from '@continuum-memory/contracts'
import type { GraphSemanticRecord } from './types'

/** L2 is authoritative and independently versioned; navigation and model scores are not relations. */
export const GRAPH_RELATION_SCHEMA_VERSION = 1 as const

export type GraphRelationKind = 'entails' | 'contradicts' | 'causes' | 'precedes' | 'explains'
export type GraphNliLabel = 'CONTRADICTION' | 'NEUTRAL' | 'ENTAILMENT'

export interface GraphRelationEvidence {
  readonly source: GraphSourceRef
  readonly role: 'supports' | 'refutes'
}

/** A candidate is not an L2 semantic fact, even when a model predicts entailment. */
export interface GraphRelationCandidate {
  readonly id: string
  readonly scope: GraphScope
  readonly from: GraphClaimRef
  readonly to: GraphClaimRef
  readonly kind: GraphRelationKind
  readonly context: GraphContextRef
  readonly validTime: GraphTimeExtent
  readonly sourceHints: readonly GraphSourceRef[]
  readonly hypothesisText: string
  readonly generator: {
    readonly route: 'dense' | 'structured' | 'source-cue' | 'relation-neighbor' | 'human'
    readonly version: string
  }
  readonly resolution: { readonly status: 'pending' }
    | { readonly status: 'accepted'; readonly relation: GraphRelationRef }
    | { readonly status: 'rejected'; readonly reason: string }
}

/** Rebuildable model observation. Scores describe a text pair, not the truth of a relation. */
export interface GraphNliObservation {
  readonly id: string
  readonly candidateId: string
  readonly premise: { readonly kind: 'claim'; readonly ref: GraphClaimRef }
    | { readonly kind: 'source'; readonly ref: GraphSourceRef }
  readonly premiseHash: string
  readonly hypothesisHash: string
  readonly scores: Readonly<Record<GraphNliLabel, number>>
  readonly predicted: GraphNliLabel
  readonly modelId: string
  readonly modelRevision: string
  readonly preprocessingVersion: string
  readonly truncated: boolean
  readonly evaluatedAt: number
}

/** Only reviewed source assertions belong here. Inference-only hypotheses stay candidates. */
export interface GraphRelationRecord extends GraphSemanticRecord {
  readonly ref: GraphRelationRef
  readonly from: GraphClaimRef
  readonly to: GraphClaimRef
  readonly kind: GraphRelationKind
  readonly polarity: GraphPolarity
  readonly modality: GraphModality
  readonly context: GraphContextRef
  readonly validTime: GraphTimeExtent
  readonly assertionBasis: 'source-explicit' | 'user-confirmed'
  readonly evidence: NonEmptyReadonlyArray<GraphRelationEvidence>
  readonly candidateId?: string
  readonly nliObservationIds: readonly string[]
}

export interface GraphRelationManifest {
  readonly protocolVersion: GraphProtocolVersion
  readonly schemaVersion: typeof GRAPH_RELATION_SCHEMA_VERSION
  readonly manifestId: string
  readonly scope: GraphScope
  /** Exact L1 projection used to validate endpoints. A changed core invalidates this view. */
  readonly coreManifestId: string
  readonly sourceBundleId: string
  /** Changes only when authoritative relations change; L3/L4 pin this revision. */
  readonly relationRevision: number
  readonly candidateRevision: number
  readonly createdAt: number
  readonly state: 'ready' | 'stale'
}

export interface GraphRelationSnapshot {
  readonly manifest: GraphRelationManifest
  readonly relations: readonly GraphRelationRecord[]
  readonly candidates: readonly GraphRelationCandidate[]
  readonly observations: readonly GraphNliObservation[]
}

/** Read-time projection only. Resolve relationRef for provenance and current authorization. */
export interface GraphRelationEdge {
  readonly id: string
  readonly layer: 'semantic'
  readonly kind: 'relation'
  readonly relation: GraphRelationRef
  readonly relationKind: GraphRelationKind
  readonly from: GraphClaimRef
  readonly to: GraphClaimRef
  readonly polarity: GraphPolarity
  readonly modality: GraphModality
  readonly validTime: GraphTimeExtent
  readonly sensitivity: MemorySensitivity
  readonly sharePolicy: MemorySharePolicy
}
