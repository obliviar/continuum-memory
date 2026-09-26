import type {
  GraphAnswerRef,
  GraphClaimRef,
  GraphFactRef,
  GraphRecallBudget,
  GraphRecallRequest,
  GraphResult,
  GraphRuleRef,
  GraphScope,
  GraphSourceRef,
  GraphStatementRef,
  GraphTemporalQuery,
  MemorySensitivity,
  MemorySharePolicy,
} from '@continuum-memory/contracts'
import type {
  GraphClaimRecord,
  GraphEdge,
  GraphGroundTerm,
  GraphNodeRef,
  GraphProjectionManifest,
  GraphProjectionSnapshot,
  GraphRuleRecord,
  GraphSemanticBundle,
  GraphStatementRecord,
} from '../domain/types'

/** Issued by the trusted host after authentication. A structurally valid object is NOT authorization. */
export interface GraphAccessContext {
  readonly accessContextId: string
  readonly authorizationVersion: string
  readonly scope: GraphScope
  readonly sharePolicies: readonly MemorySharePolicy[]
  readonly sensitivities: readonly MemorySensitivity[]
}

export interface GraphOpenViewRequest {
  readonly access: GraphAccessContext
  readonly temporal: GraphTemporalQuery
  readonly budget: GraphRecallBudget
  readonly expectedManifestId: string
  /** Optional exact L3/L4 view; omitted means no hierarchy traversal. */
  readonly expectedHierarchyManifestId?: string
  readonly policyVersion: string
}

/** Opaque cursors must bind the view ID, query fingerprint and scan position. */
export interface GraphPageRequest {
  readonly limit: number
  readonly maxScanned: number
  readonly cursor?: string
}
export type GraphPage<T> = {
  readonly items: readonly T[]
  readonly scanned: number
} & (
  | { readonly completion: 'complete'; readonly nextCursor?: never }
  | { readonly completion: 'more'; readonly nextCursor: string }
  | { readonly completion: 'budget-exhausted'; readonly nextCursor?: string }
)

export interface GraphNeighborQuery extends GraphPageRequest {
  readonly node: GraphNodeRef
  readonly layer: GraphEdge['layer']
  readonly direction: 'out' | 'in' | 'both'
  readonly kinds: readonly GraphEdge['kind'][]
}

export interface GraphBindingQuery extends GraphPageRequest {
  readonly rule: GraphRuleRef
  readonly bindings: Readonly<Record<string, GraphGroundTerm>>
}

/** Not a proof: the rule executor/verifier must check all paths, evidence and conflicts. */
export interface GraphBindingCandidate {
  readonly bindings: Readonly<Record<string, GraphGroundTerm>>
  readonly premises: readonly { readonly ref: GraphAnswerRef; readonly bodyPath: readonly number[] }[]
}

export interface GraphReadView {
  readonly viewId: string
  readonly manifest: GraphProjectionManifest
  readonly context: GraphOpenViewRequest
  /** Exact versions only. Any missing/inaccessible source is an explicit error, not a shorter array. */
  resolveClaims: (refs: readonly GraphClaimRef[]) => Promise<GraphResult<readonly GraphClaimRecord[]>>
  resolveStatements: (refs: readonly GraphStatementRef[]) => Promise<GraphResult<readonly GraphStatementRecord[]>>
  resolveRules: (refs: readonly GraphRuleRef[]) => Promise<GraphResult<readonly GraphRuleRecord[]>>
  neighbors: (query: GraphNeighborQuery) => Promise<GraphResult<GraphPage<GraphEdge>>>
  matchRuleBody: (query: GraphBindingQuery) => Promise<GraphResult<GraphPage<GraphBindingCandidate>>>
  /** Optional explicit policy; absence does not certify conflict completeness. */
  readonly conflictPolicy?: 'exact-opposite-polarity-v1'
  /** Policy-scoped lookup; not sufficient on its own to validate proofs. */
  findConflicts: (ref: GraphClaimRef, page: GraphPageRequest) => Promise<GraphResult<GraphPage<GraphClaimRecord>>>
  close: () => Promise<void>
}

export interface GraphReadPort {
  openView: (request: GraphOpenViewRequest) => Promise<GraphResult<GraphReadView>>
}

export interface GraphSourceContent {
  readonly ref: GraphSourceRef
  readonly content: string
  readonly scope: GraphScope
}

/** Recheck CURRENT authorization/tombstones even when reading a historical manifest. */
export interface GraphEvidenceReader {
  readSources: (view: GraphReadView, refs: readonly GraphSourceRef[]) => Promise<GraphResult<readonly GraphSourceContent[]>>
  resolveFactVersions: (view: GraphReadView, refs: readonly GraphFactRef[]) => Promise<GraphResult<readonly {
    readonly ref: GraphFactRef
    readonly canonicalText: string
    readonly sources: readonly GraphSourceRef[]
  }[]>>
}

export interface GraphSeedPort {
  search: (request: GraphRecallRequest, view: GraphReadView) => Promise<GraphResult<GraphPage<{
    readonly ref: GraphAnswerRef
    readonly route: 'lexical' | 'dense' | 'structured' | 'summary'
    readonly relevance: number
  }>>>
}

/** CAS publication of a COMPLETE immutable source bundle, never independent partial file writes. */
export interface GraphSemanticWritePort {
  publish: (request: {
    readonly operationId: string
    readonly expectedBundleId: string | null
    readonly bundle: GraphSemanticBundle
  }) => Promise<GraphResult<{ readonly bundleId: string }>>
}

export interface GraphProjectionWritePort {
  publish: (request: {
    readonly operationId: string
    readonly expectedManifestId: string | null
    readonly snapshot: GraphProjectionSnapshot
  }) => Promise<GraphResult<{ readonly manifestId: string }>>
  /** Revoke first, then rebuild. A stale projection must not issue new validated proofs. */
  invalidate: (request: {
    readonly operationId: string
    readonly scope: GraphScope
    readonly manifestId: string
    readonly reason: 'source-changed' | 'source-deleted' | 'rule-revoked' | 'alias-changed' | 'authorization-changed'
  }) => Promise<GraphResult<{ readonly invalidated: boolean }>>
}
