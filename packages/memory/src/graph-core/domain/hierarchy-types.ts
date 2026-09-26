import type {
  GraphClaimRef,
  GraphCommunityRef,
  GraphContextRef,
  GraphEntityRef,
  GraphProtocolVersion,
  GraphRelationRef,
  GraphScope,
  GraphSourceRef,
  GraphStatementRef,
  GraphSummaryRef,
  GraphTimeExtent,
  GraphTransactionTime,
  MemorySensitivity,
  MemorySharePolicy,
  NonEmptyReadonlyArray,
} from '@continuum-memory/contracts'

/** L3/L4 are rebuildable navigation views, not accepted L1/L2 semantic records or proof. */
export const GRAPH_HIERARCHY_SCHEMA_VERSION = 1 as const

export interface GraphHierarchySourceSnapshot {
  /** Exact ready L1/P graph projection used to build this hierarchy. */
  readonly coreManifestId: string
  readonly coreNavigationRevision: number
  /** null until an authoritative L2 relation store exists; relation refs then must be absent. */
  readonly relationRevision: number | null
  /** A changed authorization or source policy invalidates previously readable summaries. */
  readonly authorizationVersion: string
  readonly policyVersion: string
}

export interface GraphHierarchyManifest {
  readonly protocolVersion: GraphProtocolVersion
  readonly schemaVersion: typeof GRAPH_HIERARCHY_SCHEMA_VERSION
  readonly manifestId: string
  readonly scope: GraphScope
  readonly source: GraphHierarchySourceSnapshot
  readonly communityRevision: number
  readonly summaryRevision: number
  readonly builderVersion: string
  readonly createdAt: number
  readonly state: 'building' | 'ready' | 'stale' | 'failed'
}

/** Event frames are not an L1 record yet; event-like content is addressed by exact claims/statements. */
export type GraphSummarySupportRef = GraphClaimRef | GraphStatementRef
/** L2 relations may be members only when source.relationRevision is not null. */
export type GraphCommunityMemberRef = GraphSummarySupportRef | GraphRelationRef

export type GraphCommunityMembershipBasis =
  | { readonly kind: 'seed' }
  | { readonly kind: 'relation'; readonly ref: GraphRelationRef }
  | { readonly kind: 'shared-entity'; readonly ref: GraphEntityRef }
  | { readonly kind: 'navigation'; readonly edgeId: string }

export interface GraphCommunityRecord {
  readonly ref: GraphCommunityRef
  readonly scope: GraphScope
  readonly transactionTime: GraphTransactionTime
  readonly validTime: GraphTimeExtent
  readonly contexts: readonly GraphContextRef[]
  readonly anchorEntities: readonly GraphEntityRef[]
  /** 0 is the leaf level. Larger levels may contain child communities. */
  readonly level: number
  /** Count of direct members, excluding members of child communities. */
  readonly memberCount: number
  /** Conservative aggregate; reads still recheck every underlying member. */
  readonly sensitivity: MemorySensitivity
  readonly sharePolicy: MemorySharePolicy
  readonly construction: {
    readonly algorithm: string
    readonly version: string
    readonly parametersHash: string
    readonly sourceFingerprint: string
  }
}

export type GraphSummaryOrigin =
  | { readonly kind: 'community'; readonly ref: GraphCommunityRef }
  | { readonly kind: 'group'; readonly grouping: 'session' | 'day' | 'topic' | 'entity' | 'phase' | 'event-chain' | 'time-window'; readonly key: string }

export interface GraphSummaryRecord {
  readonly ref: GraphSummaryRef
  readonly scope: GraphScope
  readonly transactionTime: GraphTransactionTime
  readonly validTime: GraphTimeExtent
  readonly contexts: readonly GraphContextRef[]
  readonly origin: GraphSummaryOrigin
  /** 0 summarizes source records; higher levels may cover lower summaries. */
  readonly level: number
  /** Derived text is an entry point only. Answer citations still require current source evidence. */
  readonly content: string
  /** Hash of the exact content, not an underlying episode or another summary. */
  readonly contentHash: string
  /** Conservative aggregate; reads still recheck every underlying source. */
  readonly sensitivity: MemorySensitivity
  readonly sharePolicy: MemorySharePolicy
  readonly generation: {
    readonly model: string
    readonly version: string
    readonly promptVersion: string
    readonly sourceFingerprint: string
  }
}

export interface GraphHierarchyEdgeBase {
  readonly id: string
  readonly layer: 'navigation'
}

export type GraphCommunityMembershipEdge = GraphHierarchyEdgeBase & {
  readonly kind: 'in-community'
  readonly from: GraphCommunityMemberRef
  readonly to: GraphCommunityRef
  readonly role: 'core' | 'bridge'
  readonly basis: NonEmptyReadonlyArray<GraphCommunityMembershipBasis>
}

export type GraphCommunityLinkEdge = GraphHierarchyEdgeBase & (
  | { readonly kind: 'subcommunity-of'; readonly from: GraphCommunityRef; readonly to: GraphCommunityRef }
  | { readonly kind: 'community-bridge'; readonly from: GraphCommunityRef; readonly to: GraphCommunityRef; readonly basis: NonEmptyReadonlyArray<GraphCommunityMembershipBasis> }
)

export type GraphSummaryCoverageRef = GraphCommunityMemberRef | GraphCommunityRef | GraphSummaryRef
export type GraphSummaryCoverageEdge = GraphHierarchyEdgeBase & {
  readonly kind: 'summarizes'
  readonly from: GraphSummaryRef
  readonly to: GraphSummaryCoverageRef
}

/** These edges organize traversal; even relation-backed edges do not establish a new fact. */
export type GraphHierarchyEdge = GraphCommunityMembershipEdge | GraphCommunityLinkEdge | GraphSummaryCoverageEdge
export type GraphHierarchyNodeRef = GraphCommunityMemberRef | GraphRelationRef | GraphCommunityRef | GraphSummaryRef

/** Each factual span must have exact L1 support and source versions, not just a lower summary/community ID. */
export interface GraphSummaryAssertion {
  readonly id: string
  readonly summary: GraphSummaryRef
  readonly span: { readonly unit: 'utf16'; readonly start: number; readonly end: number }
  readonly support: NonEmptyReadonlyArray<GraphSummarySupportRef>
  readonly relationRefs: readonly GraphRelationRef[]
  readonly sources: NonEmptyReadonlyArray<GraphSourceRef>
  readonly qualifier: 'asserted' | 'reported' | 'hypothesis' | 'conflicted' | 'unknown'
}

/**
 * Publish atomically. Validate exact/same-scope refs, member counts, asserted spans,
 * coverage closure and acyclic subcommunity/summary links. No relation refs with a
 * null relationRevision. A summary's factual spans must resolve to current L1 sources.
 */
export interface GraphHierarchySnapshot {
  readonly manifest: GraphHierarchyManifest
  readonly communities: readonly GraphCommunityRecord[]
  readonly summaries: readonly GraphSummaryRecord[]
  readonly assertions: readonly GraphSummaryAssertion[]
  readonly edges: readonly GraphHierarchyEdge[]
}
