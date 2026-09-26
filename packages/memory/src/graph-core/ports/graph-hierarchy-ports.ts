import type {
  GraphCommunityRef,
  GraphRecallRequest,
  GraphResult,
  GraphScope,
  GraphSummaryRef,
} from '@continuum-memory/contracts'
import type {
  GraphCommunityMembershipEdge,
  GraphCommunityRecord,
  GraphHierarchyEdge,
  GraphHierarchyManifest,
  GraphHierarchyNodeRef,
  GraphHierarchySnapshot,
  GraphSummaryAssertion,
  GraphSummaryCoverageEdge,
  GraphSummaryRecord,
} from '../domain/hierarchy-types'
import type { GraphPage, GraphPageRequest, GraphReadView } from './graph-ports'

/** L3/L4 is optional and opens only against a pinned, authorized core graph view. */
export interface GraphHierarchyOpenViewRequest {
  readonly coreView: GraphReadView
  readonly expectedHierarchyManifestId: string
}

export interface GraphHierarchyNeighborQuery extends GraphPageRequest {
  readonly node: GraphHierarchyNodeRef
  readonly direction: 'out' | 'in' | 'both'
  readonly kinds: readonly GraphHierarchyEdge['kind'][]
}

export interface GraphHierarchyReadView {
  readonly viewId: string
  readonly coreViewId: string
  readonly manifest: GraphHierarchyManifest
  /** Exact versions only; missing or inaccessible refs fail rather than silently shortening the result. */
  resolveCommunities: (refs: readonly GraphCommunityRef[]) => Promise<GraphResult<readonly GraphCommunityRecord[]>>
  /** Recheck CURRENT authorization, tombstones, and all covered sources before returning text. */
  resolveSummaries: (refs: readonly GraphSummaryRef[]) => Promise<GraphResult<readonly GraphSummaryRecord[]>>
  members: (community: GraphCommunityRef, page: GraphPageRequest) => Promise<GraphResult<GraphPage<GraphCommunityMembershipEdge>>>
  coverage: (summary: GraphSummaryRef, page: GraphPageRequest) => Promise<GraphResult<GraphPage<GraphSummaryCoverageEdge>>>
  assertions: (summary: GraphSummaryRef, page: GraphPageRequest) => Promise<GraphResult<GraphPage<GraphSummaryAssertion>>>
  neighbors: (query: GraphHierarchyNeighborQuery) => Promise<GraphResult<GraphPage<GraphHierarchyEdge>>>
  close: () => Promise<void>
}

export interface GraphHierarchyReadPort {
  /** Require ready manifests, equal scope/core manifest/auth and policy versions, and live core view. */
  openView: (request: GraphHierarchyOpenViewRequest) => Promise<GraphResult<GraphHierarchyReadView>>
}

export interface GraphHierarchySeedPort {
  /** Navigation candidates only. Down-drill to current claims/sources before answering. */
  search: (request: GraphRecallRequest, coreView: GraphReadView, hierarchyView: GraphHierarchyReadView, page: GraphPageRequest) => Promise<GraphResult<GraphPage<{
    readonly ref: GraphCommunityRef | GraphSummaryRef
    readonly route: 'community-lexical' | 'community-dense' | 'summary-lexical' | 'summary-dense'
    readonly relevance: number
  }>>>
}

export interface GraphHierarchyWritePort {
  /** CAS publication of a complete immutable view; validate every referenced version and summary assertion. */
  publish: (request: {
    readonly operationId: string
    readonly expectedManifestId: string | null
    readonly snapshot: GraphHierarchySnapshot
  }) => Promise<GraphResult<{ readonly manifestId: string }>>
  /** Revoke before rebuilding; stale summaries must never be served as independent evidence. */
  invalidate: (request: {
    readonly operationId: string
    readonly scope: GraphScope
    readonly manifestId: string
    readonly reason: 'core-changed' | 'relation-changed' | 'source-deleted'
      | 'authorization-changed' | 'policy-changed' | 'community-changed'
  }) => Promise<GraphResult<{ readonly invalidated: boolean }>>
}
