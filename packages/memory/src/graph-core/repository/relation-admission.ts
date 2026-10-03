import { createHash } from 'node:crypto'
import type { GraphRelationRef, GraphResult } from '@continuum-memory/contracts'
import type { GraphClaimRecord, GraphProjectionSnapshot } from '../domain/types'
import type { GraphRelationRecord } from '../domain/relation-types'
import type { GraphRelationRepository } from './relation-repository'
import { basicStatementIdentitiesCompatible } from '../domain/source-statement-comparison'

export const GRAPH_L2_ADMISSION_VERSION = 'l2-user-confirmed-v1'

/** This is an explicit semantic decision, separate from reviewing an NLI classification. */
export async function publishReviewedGraphRelation(input: {
  readonly repository: GraphRelationRepository
  readonly core: GraphProjectionSnapshot
  readonly candidateId: string
  readonly reason: string
  readonly reviewer: string
  /** Re-read the exact source text; a persisted NLI hash is not a live authorization. */
  readonly evidenceText: (claim: GraphClaimRecord) => string
  readonly now?: () => number
}): Promise<GraphResult<{ readonly manifestId: string; readonly relationRef: GraphRelationRef }>> {
  const current = input.repository.snapshot()
  if (current.manifest.state !== 'ready' || input.core.manifest.state !== 'ready'
    || current.manifest.coreManifestId !== input.core.manifest.manifestId)
    return failure('stale-projection', 'L2 admission requires a ready exact L1 view')
  const candidate = current.candidates.find(item => item.id === input.candidateId)
  if (!candidate) return failure('invalid-request', 'Relation candidate is unavailable')
  if (candidate.resolution.status === 'accepted')
    return { ok: true, value: { manifestId: current.manifest.manifestId, relationRef: candidate.resolution.relation } }
  if (candidate.resolution.status !== 'pending')
    return failure('invalid-request', 'Rejected relation candidate cannot be published')
  const reason = input.reason.trim()
  const reviewer = input.reviewer.trim()
  if (!reason || !reviewer || reason.length > 500)
    return failure('invalid-request', 'Relation publication requires a reviewer and concise reason')
  // The current NLI route proposes logical relations only. It never asserts cause, time, or explanation.
  if (candidate.kind !== 'entails' && candidate.kind !== 'contradicts')
    return failure('invalid-request', 'This admission route accepts logical relations only')
  const from = input.core.semanticBundle.claims.find(claim => refKey(claim.ref) === refKey(candidate.from))
  const to = input.core.semanticBundle.claims.find(claim => refKey(claim.ref) === refKey(candidate.to))
  const observations = current.observations.filter(item => {
    if (item.candidateId !== candidate.id || item.truncated
      || item.predicted !== (candidate.kind === 'entails' ? 'ENTAILMENT' : 'CONTRADICTION')) return false
    const premise = [from, to].find(claim => claim && item.premise.kind === 'claim'
      && refKey(claim.ref) === refKey(item.premise.ref))
    const hypothesis = premise && [from, to].find(claim => claim && refKey(claim.ref) !== refKey(premise.ref))
    return !!premise && !!hypothesis
      && digestText(input.evidenceText(premise)) === item.premiseHash
      && digestText(input.evidenceText(hypothesis)) === item.hypothesisHash
  })
  if (!from || !to || from.transactionTime.closedAt !== null || to.transactionTime.closedAt !== null
    || from.review.status !== 'accepted' || to.review.status !== 'accepted'
    || refKey(from.context) !== refKey(candidate.context) || refKey(to.context) !== refKey(candidate.context)
    || from.modality !== to.modality || candidate.sourceHints.length === 0 || observations.length === 0
    || !basicStatementIdentitiesCompatible(from, to, input.core.semanticBundle.entities))
    return failure('invalid-request', 'Candidate lacks exact live endpoints, sources, or untruncated observation')
  const at = input.now?.() ?? Date.now()
  if (!Number.isSafeInteger(at) || at <= Math.max(from.review.reviewedAt, to.review.reviewedAt))
    return failure('invalid-request', 'Relation review time must follow its endpoint reviews')
  const sensitivity = rankMax(from.sensitivity, to.sensitivity, ['normal', 'private', 'secret'] as const)
  const sharePolicy = rankMax(from.sharePolicy, to.sharePolicy, ['allow-remote', 'ask', 'local-only'] as const)
  const relationRef: GraphRelationRef = { kind: 'relation',
    id: `l2-relation:${digest([GRAPH_L2_ADMISSION_VERSION, candidate.id])}`, version: 1 }
  const record: GraphRelationRecord = {
    ref: relationRef, from: candidate.from, to: candidate.to, kind: candidate.kind,
    polarity: 'positive', modality: from.modality, context: candidate.context,
    validTime: candidate.validTime, assertionBasis: 'user-confirmed', reviewReason: reason,
    evidence: [{ source: candidate.sourceHints[0]!, role: 'supports' },
      ...candidate.sourceHints.slice(1).map(source => ({ source, role: 'supports' as const }))],
    candidateId: candidate.id, nliObservationIds: observations.map(item => item.id),
    scope: candidate.scope, transactionTime: { recordedAt: at, closedAt: null },
    provenance: { sources: candidate.sourceHints as GraphRelationRecord['provenance']['sources'],
      producer: 'user', normalizerVersion: GRAPH_L2_ADMISSION_VERSION },
    review: { status: 'accepted', reviewedAt: at, reviewer }, sensitivity, sharePolicy,
  }
  const candidates = current.candidates.map(item => item.id === candidate.id
    ? { ...item, resolution: { status: 'accepted' as const, relation: relationRef } } : item)
  const relations = [...current.relations, record]
  const relationRevision = current.manifest.relationRevision + 1
  const candidateRevision = current.manifest.candidateRevision + 1
  const manifestId = `l2-accepted:${digest([input.core.manifest.manifestId, relationRevision,
    candidateRevision, relations, candidates])}`
  const next = { ...current, manifest: { ...current.manifest, manifestId, relationRevision,
    candidateRevision, createdAt: Math.max(at, current.manifest.createdAt), state: 'ready' as const },
  relations, candidates }
  const result = await input.repository.publish({ operationId: `l2-accept:${candidate.id}`,
    expectedManifestId: current.manifest.manifestId, snapshot: next })
  return result.ok ? { ok: true, value: { manifestId: result.value.manifestId, relationRef } } : result
}

function rankMax<T extends string>(a: T, b: T, order: readonly T[]): T {
  return order.indexOf(a) >= order.indexOf(b) ? a : b
}

function refKey(ref: { kind: string; id: string; version: number }): string {
  return `${ref.kind}\0${ref.id}\0${ref.version}`
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function digestText(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function failure(code: 'invalid-request' | 'stale-projection', message: string): GraphResult<never> {
  return { ok: false, error: { code, message } }
}
