import type { GraphScope, MemorySensitivity } from '@continuum-memory/contracts'
import type { FactContext, SourceSpan } from '../../long-term/graph-extraction-result'

export interface OpenSourceContext {
  text: string
  span: SourceSpan
  sourceRole: 'user-message'
  truncated: boolean
}

export interface OpenNavigationAdmission {
  policyVersion: 'source-context-navigation-v1'
  localNavigation: 'automatic' | 'candidate-only' | 'blocked'
  reasons: string[]
  identityMerge: false
  claimPublication: false
  proactiveUse: false
  remoteSharing: false
}

/** Source-grounded open assertion. Domain labels and participant roles stay extensible. */
export interface GraphOpenAssertionRecord {
  readonly ref: { readonly kind: 'open-assertion'; readonly id: string; readonly version: 1 }
  readonly scope: GraphScope
  readonly source: { readonly captureId: string; readonly revision: number; readonly contentHash: string }
  readonly extraction: {
    readonly sourceId: string
    readonly sourceRevision: string
    readonly modelId: string
    readonly runId: string
    readonly candidateId: string
  }
  readonly relationText: string
  readonly relationSpan?: SourceSpan
  readonly evidenceSpan: SourceSpan
  readonly text: string
  readonly participants: readonly {
    readonly ref: { readonly kind: 'mention'; readonly id: string; readonly version: 1 }
    readonly text: string
    readonly role: string
    /** Extractor proposal, not a registered entity type or identity merge. */
    readonly typeCandidate: string
    readonly span: SourceSpan
  }[]
  readonly attributes: readonly { readonly role: string; readonly value: string; readonly typeCandidate: string }[]
  readonly context: FactContext
  readonly sourceContext?: OpenSourceContext
  readonly admission?: OpenNavigationAdmission
  readonly review: { readonly status: 'candidate' | 'accepted' | 'rejected'; readonly reason?: string; readonly reviewedAt?: number }
  readonly modelScore: number
  readonly sensitivity: MemorySensitivity
  readonly sharePolicy: 'local-only'
  readonly inferenceAllowed: false
}
