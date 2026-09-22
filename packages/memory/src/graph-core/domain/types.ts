import type {
  GraphAnswerRef,
  GraphClaimRef,
  GraphContextRef,
  GraphDerivedClaimRef,
  GraphEntityRef,
  GraphFactRef,
  GraphModality,
  GraphPolarity,
  GraphProofRef,
  GraphProtocolVersion,
  GraphRuleRef,
  GraphScope,
  GraphSourceRef,
  GraphStatementRef,
  GraphTimeExtent,
  GraphTransactionTime,
  GraphVersionRef,
  MemorySensitivity,
  MemorySharePolicy,
  NonEmptyReadonlyArray,
} from '@continuum-memory/contracts'

/** Independent of the persisted V4 schema. No existing V4 payload is rewritten by these types. */
export const MEMORY_GRAPH_SCHEMA_VERSION = 1 as const

export type GraphLiteral =
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'number'; readonly value: number; readonly unit?: string }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'date'; readonly value: string }
export type GraphGroundTerm = GraphLiteral | { readonly kind: 'entity'; readonly ref: GraphEntityRef }
export type GraphTerm = GraphGroundTerm | { readonly kind: 'variable'; readonly name: string }
export type GraphValueType = 'string' | 'number' | 'boolean' | 'date' | { readonly entityType: string }

export interface GraphAtom<T extends GraphTerm = GraphGroundTerm> {
  readonly predicate: string
  readonly args: Readonly<Record<string, T>>
}

/** Explicit signed literals only. There is no NOT-as-failure or executable arbitrary text. */
export type GraphExpression<T extends GraphTerm = GraphGroundTerm> =
  | { readonly kind: 'literal'; readonly atom: GraphAtom<T>; readonly polarity: 'positive' | 'negative' }
  | { readonly kind: 'allOf' | 'anyOf'; readonly operands: NonEmptyReadonlyArray<GraphExpression<T>> }

export type GraphCondition = { readonly kind: 'none' }
  | { readonly kind: 'parsed'; readonly text: string; readonly expression: GraphExpression }
  | { readonly kind: 'unsupported'; readonly text: string; readonly reason: string }

export interface GraphProvenance {
  readonly sources: NonEmptyReadonlyArray<GraphSourceRef>
  readonly producer: 'extractor' | 'user' | 'migration'
  readonly extractorVersion?: string
  readonly promptVersion?: string
  readonly normalizerVersion: string
}

export type GraphReview = { readonly status: 'candidate' }
  | { readonly status: 'accepted'; readonly reviewedAt: number; readonly reviewer: string }
  | { readonly status: 'rejected'; readonly reviewedAt: number; readonly reason: string }

export interface GraphSemanticRecord {
  readonly scope: GraphScope
  readonly transactionTime: GraphTransactionTime
  readonly provenance: GraphProvenance
  readonly review: GraphReview
  readonly sensitivity: MemorySensitivity
  readonly sharePolicy: MemorySharePolicy
}

export interface GraphEntityRecord extends GraphSemanticRecord {
  readonly ref: GraphEntityRef
  readonly entityType: string
  readonly canonicalName: string
  readonly aliases: readonly string[]
}

/** Reversible identity decisions; an embedding neighbour is never automatically sameAs. */
export interface GraphAliasDecision extends GraphSemanticRecord {
  readonly ref: GraphVersionRef<'alias-decision'>
  readonly action: 'merge' | 'split'
  readonly members: NonEmptyReadonlyArray<GraphEntityRef>
  readonly canonical: GraphEntityRef
  readonly reverses?: GraphVersionRef<'alias-decision'>
}

export interface GraphPredicateSpec {
  readonly ref: GraphVersionRef<'predicate'>
  readonly name: string
  readonly roles: Readonly<Record<string, { readonly type: GraphValueType; readonly required: boolean }>>
  /** Unspecified constraints must NOT be inferred from the predicate's natural-language name. */
  readonly cardinality: 'single' | 'multiple' | 'set'
  readonly keyRoles: readonly string[]
  readonly valueRole: string | null
  readonly symmetry: 'none' | 'symmetric'
  readonly transitivity: 'none' | 'approved'
  readonly inferenceAllowed: boolean
  readonly world: 'open'
}

export interface GraphContextRecord extends GraphSemanticRecord {
  readonly ref: GraphContextRef
  readonly domain: string
  readonly scenario: 'actual' | 'hypothetical'
  readonly parent: GraphContextRef | null
}

export interface GraphClaimRecord extends GraphSemanticRecord {
  readonly ref: GraphClaimRef
  readonly fact: GraphFactRef
  readonly atom: GraphAtom
  readonly polarity: GraphPolarity
  readonly modality: GraphModality
  readonly condition: GraphCondition
  readonly context: GraphContextRef
  readonly validTime: GraphTimeExtent
  readonly evidence: NonEmptyReadonlyArray<{
    readonly source: GraphSourceRef
    readonly role: 'supports' | 'refutes' | 'references'
    readonly strength: 'direct' | 'reference-only' | 'legacy-derived'
  }>
}

/** An accepted anyOf root does not accept either child as a standalone fact. */
export interface GraphStatementRecord extends GraphSemanticRecord {
  readonly ref: GraphStatementRef
  readonly fact: GraphFactRef
  readonly expression: GraphExpression
  readonly modality: GraphModality
  readonly context: GraphContextRef
  readonly validTime: GraphTimeExtent
}

export interface GraphRuleRecord extends GraphSemanticRecord {
  readonly ref: GraphRuleRef
  readonly variables: Readonly<Record<string, GraphValueType>>
  readonly body: GraphExpression<GraphTerm>
  /** V1 has a single signed head. No disjunctive head, functions, or fresh entities. */
  readonly head: { readonly atom: GraphAtom<GraphTerm>; readonly polarity: 'positive' | 'negative' }
  readonly context: GraphContextRef
  readonly validTime: GraphTimeExtent
  readonly execution: 'disabled' | 'approved'
}

export interface GraphDerivedClaimRecord {
  readonly ref: GraphDerivedClaimRef
  readonly scope: GraphScope
  readonly manifestId: string
  readonly atom: GraphAtom
  readonly polarity: 'positive' | 'negative'
  readonly modality: 'inferred'
  readonly context: GraphContextRef
  readonly validTime: GraphTimeExtent
  /** Independent proofs survive revocation of another proof. No direct V4 Fact identity. */
  readonly proofs: NonEmptyReadonlyArray<GraphProofRef>
}

export interface GraphProofRecord {
  readonly ref: GraphProofRef
  readonly scope: GraphScope
  readonly manifestId: string
  readonly conclusion: GraphDerivedClaimRef
  readonly rule: GraphRuleRef
  readonly premises: NonEmptyReadonlyArray<GraphAnswerRef>
  readonly bindings: Readonly<Record<string, GraphGroundTerm>>
  /** Selected paths in the rule body; [] denotes the root. Preserve the chosen OR branches. */
  readonly bodyPaths: NonEmptyReadonlyArray<readonly number[]>
  readonly context: GraphContextRef
  readonly validTime: GraphTimeExtent
  readonly sources: NonEmptyReadonlyArray<GraphSourceRef>
  readonly verification: { readonly status: 'validated'; readonly verifierVersion: string; readonly checkedAt: number }
    | { readonly status: 'pending' | 'missing-premise' | 'conflicted-premise' | 'unsupported' | 'stale'; readonly reason: string }
}

export interface GraphSourceRevisions {
  readonly v4: number
  readonly semantics: number
  readonly predicates: number
  readonly rules: number
  readonly aliases: number
}

/** Accepted semantic decisions must be persisted, not reconstructed by rerunning a model. */
export interface GraphSemanticBundle {
  readonly schemaVersion: typeof MEMORY_GRAPH_SCHEMA_VERSION
  readonly bundleId: string
  readonly scope: GraphScope
  readonly revisions: GraphSourceRevisions
  readonly entities: readonly GraphEntityRecord[]
  readonly aliases: readonly GraphAliasDecision[]
  readonly predicates: readonly GraphPredicateSpec[]
  readonly contexts: readonly GraphContextRecord[]
  readonly claims: readonly GraphClaimRecord[]
  readonly statements: readonly GraphStatementRecord[]
  readonly rules: readonly GraphRuleRecord[]
}

export interface GraphProjectionManifest {
  readonly protocolVersion: GraphProtocolVersion
  readonly schemaVersion: typeof MEMORY_GRAPH_SCHEMA_VERSION
  readonly manifestId: string
  readonly sourceBundleId: string
  readonly scope: GraphScope
  readonly sourceRevisions: GraphSourceRevisions
  /** Excludes usage/access counters. Builder versions belong here, NEVER in entity/claim IDs. */
  readonly semanticFingerprint: string
  readonly builderVersion: string
  readonly navigationRevision: number
  readonly createdAt: number
  readonly state: 'building' | 'ready' | 'stale' | 'failed'
}

export type GraphNavigationRef = GraphVersionRef<'navigation'>
export type GraphSemanticNodeRef = GraphEntityRef | GraphClaimRef | GraphStatementRef
  | GraphRuleRef | GraphProofRef | GraphDerivedClaimRef
export type GraphNodeRef = GraphSemanticNodeRef | GraphNavigationRef

/** Proof dependence points FROM the proof TO its prerequisites, not independent entailment edges. */
export type GraphSemanticEdge = { readonly id: string; readonly layer: 'semantic' } & (
  | { readonly kind: 'has-argument'; readonly from: GraphClaimRef | GraphDerivedClaimRef; readonly to: GraphEntityRef; readonly role: string }
  | { readonly kind: 'uses-premise'; readonly from: GraphProofRef; readonly to: GraphAnswerRef; readonly bodyPath: readonly number[] }
  | { readonly kind: 'uses-rule'; readonly from: GraphProofRef; readonly to: GraphRuleRef }
  | { readonly kind: 'concludes'; readonly from: GraphProofRef; readonly to: GraphDerivedClaimRef }
  | { readonly kind: 'conflicts-with'; readonly from: GraphClaimRef; readonly to: GraphClaimRef; readonly validTime: GraphTimeExtent }
)

export interface GraphNavigationEdge {
  readonly id: string
  readonly layer: 'navigation'
  readonly kind: 'similar' | 'in-summary' | 'co-mentioned' | 'discourse'
  readonly from: GraphNodeRef
  readonly to: GraphNodeRef
  readonly score: number
}
export type GraphEdge = GraphSemanticEdge | GraphNavigationEdge

/** Provenance and body ASTs stay on the records; adapters may index them, never flatten away AND/OR. */
export interface GraphProjectionSnapshot {
  readonly manifest: GraphProjectionManifest
  readonly semanticBundle: GraphSemanticBundle
  readonly derivedClaims: readonly GraphDerivedClaimRecord[]
  readonly proofs: readonly GraphProofRecord[]
  readonly edges: readonly GraphEdge[]
}
