import type {
  GraphClaimRef,
  GraphRelationRef,
  GraphResult,
  GraphScope,
  GraphSourceRef,
} from '@continuum-memory/contracts'
import type {
  GraphNliLabel,
  GraphRelationCandidate,
  GraphRelationEdge,
  GraphRelationKind,
  GraphRelationManifest,
  GraphRelationRecord,
  GraphRelationSnapshot,
} from '../domain/relation-types'
import type { GraphPage, GraphPageRequest, GraphReadView } from './graph-ports'

/** The L2 view is pinned to a live, authorized exact L1 view. */
export interface GraphRelationOpenViewRequest {
  readonly coreView: GraphReadView
  readonly expectedRelationManifestId: string
}

export interface GraphRelationNeighborQuery extends GraphPageRequest {
  readonly claim: GraphClaimRef
  readonly direction: 'out' | 'in' | 'both'
  readonly kinds: readonly GraphRelationKind[]
}

export interface GraphRelationReadView {
  readonly viewId: string
  readonly coreViewId: string
  readonly manifest: GraphRelationManifest
  /** Exact versions only; authorization and source tombstones are rechecked at read time. */
  resolveRelations: (refs: readonly GraphRelationRef[]) => Promise<GraphResult<readonly GraphRelationRecord[]>>
  /** Only accepted, current relations become semantic edges. */
  neighbors: (query: GraphRelationNeighborQuery) => Promise<GraphResult<GraphPage<GraphRelationEdge>>>
  close: () => Promise<void>
}

export interface GraphRelationReadPort {
  /** Reject stale source revisions, mismatched core manifests, and unauthorized views. */
  openView: (request: GraphRelationOpenViewRequest) => Promise<GraphResult<GraphRelationReadView>>
}

/** Full-snapshot CAS. The host must verify live source spans and their access policy before publication. */
export interface GraphRelationWritePort {
  publish: (request: {
    readonly operationId: string
    readonly expectedManifestId: string
    readonly snapshot: GraphRelationSnapshot
  }) => Promise<GraphResult<{ readonly manifestId: string; readonly relationRevision: number }>>
  /** Invalidate before rebuilding or purging affected source-backed relations. */
  invalidate: (request: {
    readonly operationId: string
    readonly scope: GraphScope
    readonly expectedManifestId: string
    readonly nextManifestId: string
    readonly reason: 'core-changed' | 'source-deleted' | 'source-changed' | 'authorization-changed' | 'policy-changed'
  }) => Promise<GraphResult<{ readonly invalidated: boolean }>>
  /** Remove source/claim-backed data atomically, then mark L2 stale until rebuilt. */
  purge: (request: {
    readonly operationId: string
    readonly scope: GraphScope
    readonly expectedManifestId: string
    readonly nextManifestId: string
    readonly sourceVersions: readonly GraphSourceRef[]
    readonly claimVersions: readonly GraphClaimRef[]
  }) => Promise<GraphResult<{ readonly removedRelations: number; readonly removedCandidates: number; readonly removedObservations: number }>>
}

/** Candidate discovery may combine dense seeds, exact keys, source cues, and one-hop L2 neighbors. */
export interface GraphRelationCandidatePort {
  discover: (request: {
    readonly claim: GraphClaimRef
    readonly coreView: GraphReadView
    readonly maxCandidates: number
    readonly maxNeighborHops: 0 | 1
  }) => Promise<GraphResult<readonly GraphRelationCandidate[]>>
}

/** The local NLI model scores a prepared pair; it cannot choose relation endpoints or relation kind. */
export interface GraphNliJudgePort {
  judge: (request: {
    readonly premise: { readonly kind: 'claim'; readonly ref: GraphClaimRef; readonly text: string }
      | { readonly kind: 'source'; readonly ref: GraphSourceRef; readonly text: string }
    readonly hypothesisText: string
  }) => Promise<GraphResult<{
    readonly scores: Readonly<Record<GraphNliLabel, number>>
    readonly modelId: string
    readonly modelRevision: string
    readonly preprocessingVersion: string
    readonly truncated: boolean
  }>>
}
