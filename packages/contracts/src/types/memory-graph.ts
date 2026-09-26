import type { MemorySensitivity, MemorySharePolicy } from '../ports/memory-port'

/** Opt-in wire protocol. V3/V4 recall does NOT implement this protocol implicitly. */
export const MEMORY_GRAPH_PROTOCOL_VERSION = 'memory-graph/v1' as const
export type GraphProtocolVersion = typeof MEMORY_GRAPH_PROTOCOL_VERSION
export type NonEmptyReadonlyArray<T> = readonly [T, ...T[]]

/** The trusted host resolves the agent explicitly; the graph never guesses a default. */
export interface GraphScope {
  readonly ownerId: string
  readonly agentId: string
  /** Omitted means all authorized sessions, not an empty session. */
  readonly sessionId?: string
}

export interface GraphVersionRef<K extends string> {
  readonly kind: K
  readonly id: string
  readonly version: number
}
export type GraphEntityRef = GraphVersionRef<'entity'>
export type GraphClaimRef = GraphVersionRef<'claim'>
export type GraphStatementRef = GraphVersionRef<'statement'>
export type GraphRuleRef = GraphVersionRef<'rule'>
export type GraphProofRef = GraphVersionRef<'proof'>
export type GraphDerivedClaimRef = GraphVersionRef<'derived-claim'>
/** Relation records are owned by the relation store, not by a community projection. */
export type GraphRelationRef = GraphVersionRef<'relation'>
export type GraphCommunityRef = GraphVersionRef<'community'>
export type GraphSummaryRef = GraphVersionRef<'summary'>
export type GraphContextRef = GraphVersionRef<'context'>
export type GraphFactRef = GraphVersionRef<'v4-fact'>
export type GraphAnswerRef = GraphClaimRef | GraphDerivedClaimRef

/** Epoch milliseconds; half-open interval. null explicitly means an unbounded endpoint. */
export type GraphTimeExtent =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'interval'; readonly from: number | null; readonly to: number | null }

export interface GraphTransactionTime {
  readonly recordedAt: number
  readonly closedAt: number | null
}

/** Both clocks are resolved once by the caller. No implicit Date.now() during traversal. */
export interface GraphTemporalQuery {
  readonly valid: { readonly kind: 'at'; readonly at: number }
    | { readonly kind: 'overlap'; readonly from: number; readonly to: number }
  readonly knownAt: number
}

export interface GraphSourceRef {
  readonly episodeId: string
  /** Hash of the exact content version, not a hash of a summary. */
  readonly contentHash: string
  readonly locator: { readonly kind: 'whole-content' }
    | { readonly kind: 'text-span'; readonly unit: 'utf16'; readonly start: number; readonly end: number }
}

export type GraphPolarity = 'positive' | 'negative' | 'unknown'
export type GraphModality = 'asserted' | 'planned' | 'hypothetical' | 'reported' | 'inferred' | 'unknown'
export type GraphSupportState = 'supported' | 'refuted' | 'conflicted' | 'unknown'

/** Hard ceilings, never targets. All counters apply across the entire recall, including proof checks. */
export interface GraphRecallBudget {
  readonly maxSeeds: number
  readonly maxNodes: number
  readonly maxEdges: number
  readonly maxHops: number
  readonly maxRuleBindings: number
  readonly maxProofSteps: number
  readonly maxElapsedMs: number
  readonly maxEvidenceTokens: number
}

export interface GraphRecallRequest {
  readonly protocolVersion: GraphProtocolVersion
  readonly recallId: string
  readonly query: string
  readonly scope: GraphScope
  readonly temporal: GraphTemporalQuery
  readonly mode: 'direct-only' | 'with-proofs'
  readonly budget: GraphRecallBudget
  /** Requested restrictions; the host must intersect them with actual authorization. */
  readonly sharePolicies: readonly MemorySharePolicy[]
  readonly sensitivities: readonly MemorySensitivity[]
  readonly expectedManifestId?: string
  /** Opt in to an exact L3/L4 view; absence keeps hierarchy outside this recall. */
  readonly expectedHierarchyManifestId?: string
}

export interface GraphMemoryCapabilities {
  readonly protocolVersion: GraphProtocolVersion
  readonly temporal: 'bitemporal'
  readonly logic: 'none' | 'bounded-explicit-literals-v1'
  /** Omitted until the independently published hierarchy read port is available. */
  readonly hierarchy?: 'community-summary-v1'
  readonly budgetCeiling: GraphRecallBudget
}

export type GraphProtocolErrorCode = 'invalid-request' | 'unsupported-capability'
  | 'scope-denied' | 'version-mismatch' | 'source-unavailable' | 'unsupported-logic'
  | 'stale-projection' | 'view-closed' | 'not-ready' | 'budget-exhausted'

export interface GraphProtocolError {
  readonly code: GraphProtocolErrorCode
  /** Safe diagnostic, never inaccessible source text or a raw exception dump. */
  readonly message: string
}
export type GraphResult<T> = { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: GraphProtocolError }

export type GraphStopReason = 'exhausted-within-scope' | 'no-eligible-seeds'
  | 'coverage-satisfied' | 'node-budget' | 'edge-budget' | 'hop-budget'
  | 'binding-budget' | 'proof-budget' | 'time-budget' | 'evidence-budget'

export interface GraphRecallTrace {
  readonly recallId: string
  readonly manifestId: string
  readonly policyVersion: string
  readonly temporal: GraphTemporalQuery
  readonly completeness: 'complete-within-declared-scope' | 'incomplete'
  /** Declares the searched predicates/routes/logic subset; not a global completeness claim. */
  readonly searchScope: readonly string[]
  readonly stopReason: GraphStopReason
  readonly candidateRefs: readonly GraphAnswerRef[]
  readonly evaluatedRefs: readonly GraphAnswerRef[]
  readonly selectedRefs: readonly GraphAnswerRef[]
  /** Navigation is an entry route, not answer evidence. */
  readonly hierarchy?: {
    readonly manifestId: string
    readonly communityRefs: readonly GraphCommunityRef[]
    readonly summaryRefs: readonly GraphSummaryRef[]
  }
  /** Injection/citation is reported later by the consumer, never inferred from selection. */
  readonly usage: {
    readonly seeds: number
    readonly nodes: number
    readonly edges: number
    readonly maxHopReached: number
    readonly ruleBindings: number
    readonly proofSteps: number
    readonly elapsedMs: number
    readonly evidenceTokens: number
  }
  readonly rejected: readonly {
    readonly ref: GraphAnswerRef
    readonly reason: 'missing-premise' | 'conflicted-premise' | 'unsupported-logic'
      | 'source-unavailable' | 'time-incompatible' | 'context-incompatible' | 'budget'
  }[]
}

export interface GraphEvidenceSemantics {
  readonly polarity: GraphPolarity
  readonly modality: GraphModality
  readonly conditionText: string | null
  readonly context: GraphContextRef
  readonly validTime: GraphTimeExtent
  readonly support: GraphSupportState
}

export type GraphEvidenceClaim = GraphEvidenceSemantics & {
  readonly citation: string
  readonly content: string
  readonly sources: NonEmptyReadonlyArray<GraphSourceRef>
} & (
  | { readonly kind: 'direct'; readonly ref: GraphClaimRef; readonly fact: GraphFactRef }
  | { readonly kind: 'derived'; readonly ref: GraphDerivedClaimRef; readonly proof: GraphProofRef }
)

export interface GraphEvidenceRule {
  readonly ref: GraphRuleRef
  readonly content: string
  readonly sources: NonEmptyReadonlyArray<GraphSourceRef>
}

/** Answer-facing certificate; only ProofVerificationCore may issue validated certificates. */
export interface GraphEvidenceProof {
  readonly ref: GraphProofRef
  readonly manifestId: string
  readonly conclusion: GraphDerivedClaimRef
  readonly rule: GraphRuleRef
  readonly premises: NonEmptyReadonlyArray<GraphAnswerRef>
  readonly status: 'validated'
  readonly verifierVersion: string
}

/** Select or drop a group as a unit. All transitive premises/rules/proofs must be in the bundle. */
export interface GraphEvidenceGroup {
  readonly groupId: string
  readonly root: GraphAnswerRef
  readonly claimRefs: NonEmptyReadonlyArray<GraphAnswerRef>
  readonly ruleRefs: readonly GraphRuleRef[]
  readonly proofRefs: readonly GraphProofRef[]
}

export interface GraphAnswerEvidenceBundle {
  readonly protocolVersion: GraphProtocolVersion
  readonly recallId: string
  readonly manifestId: string
  readonly claims: readonly GraphEvidenceClaim[]
  readonly rules: readonly GraphEvidenceRule[]
  readonly proofs: readonly GraphEvidenceProof[]
  readonly groups: readonly GraphEvidenceGroup[]
}

export interface GraphRecallResult {
  readonly protocolVersion: GraphProtocolVersion
  readonly recallId: string
  readonly scope: GraphScope
  readonly manifestId: string
  readonly evidence: GraphAnswerEvidenceBundle
  readonly trace: GraphRecallTrace
}

/** A citation is a usage signal; correction/denial needs an explicit user source. */
export type GraphFeedbackEvent =
  | { readonly kind: 'injected' | 'cited' | 'ignored'; readonly target: GraphAnswerRef }
  | { readonly kind: 'user-corrected' | 'user-denied'; readonly target: GraphAnswerRef; readonly source: GraphSourceRef }

export interface GraphRecallFeedback {
  readonly protocolVersion: GraphProtocolVersion
  readonly feedbackId: string
  readonly recallId: string
  readonly manifestId: string
  readonly scope: GraphScope
  readonly recordedAt: number
  readonly events: readonly GraphFeedbackEvent[]
  readonly answerModel?: string
}
