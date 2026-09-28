import { createHash } from 'node:crypto'
import type { GraphResult, GraphSourceRef, GraphTimeExtent } from '@continuum-memory/contracts'
import type { GraphClaimRecord, GraphProjectionSnapshot } from '../domain/types'
import type { GraphNliObservation, GraphRelationCandidate } from '../domain/relation-types'
import { graphRelationPairKey, type GraphRelationJudgementTask } from './relation-task-queue'
import type { GraphRelationRepository } from './relation-repository'

export const GRAPH_L2_TASK_STAGING_VERSION = 'l2-nli-task-staging-v1'

export interface GraphL2StagingReport {
  readonly manifestId: string
  readonly stagedCandidates: number
  readonly stagedObservations: number
  readonly skipped: Readonly<Record<string, number>>
}

/** Converts completed model work into *candidates*, never authoritative L2 relations. */
export async function stageGraphRelationTasks(input: {
  readonly repository: GraphRelationRepository
  readonly core: GraphProjectionSnapshot
  readonly tasks: readonly GraphRelationJudgementTask[]
  /** Exact, current evidence text used by the NLI task. */
  readonly evidenceText: (claim: GraphClaimRecord) => string
  readonly now?: () => number
}): Promise<GraphResult<GraphL2StagingReport>> {
  const current = input.repository.snapshot()
  if (input.core.manifest.state !== 'ready' || current.manifest.state !== 'ready'
    || current.manifest.coreManifestId !== input.core.manifest.manifestId
    || current.manifest.sourceBundleId !== input.core.semanticBundle.bundleId)
    return failure('stale-projection', 'L2 staging requires a ready exact L1 view')
  const claims = new Map(input.core.semanticBundle.claims.map(claim => [refKey(claim.ref), claim]))
  const contexts = new Set(input.core.semanticBundle.contexts.map(context => refKey(context.ref)))
  const candidates = [...current.candidates]
  const observations = [...current.observations]
  const existingCandidates = new Map(candidates.map(candidate => [candidate.id, candidate]))
  const existingObservations = new Map(observations.map(observation => [observation.id, observation]))
  const skipped: Record<string, number> = {}
  let stagedCandidates = 0
  let stagedObservations = 0
  const skip = (reason: string): void => { skipped[reason] = (skipped[reason] ?? 0) + 1 }
  for (const task of input.tasks) {
    if (task.status !== 'completed' || !task.result) { skip('not-completed'); continue }
    if (task.key !== graphRelationPairKey(task.claims[0], task.claims[1], task.modelId,
      task.modelRevision, task.preprocessingVersion)) { skip('task-key-mismatch'); continue }
    const result = task.result
    if (result.label === 'NEUTRAL') { skip('neutral-is-not-a-relation'); continue }
    if (!result.scores || !result.premiseHash || !result.hypothesisHash
      || typeof result.truncated !== 'boolean'
      || !validScores(result.scores, result.label)) { skip('incomplete-nli-observation'); continue }
    const premise = claims.get(refKey(task.claims[0]))
    const hypothesis = claims.get(refKey(task.claims[1]))
    if (!premise || !hypothesis || premise.transactionTime.closedAt !== null
      || hypothesis.transactionTime.closedAt !== null) { skip('stale-claim'); continue }
    if (!sameScope(premise.scope, hypothesis.scope) || !sameScope(premise.scope, input.core.manifest.scope)
      || refKey(premise.context) !== refKey(hypothesis.context)
      || !contexts.has(refKey(premise.context))) { skip('different-context-or-scope'); continue }
    if (premise.modality !== hypothesis.modality) { skip('different-modality'); continue }
    const validTime = intersection(premise.validTime, hypothesis.validTime)
    if (!validTime) { skip('disjoint-valid-time'); continue }
    const premiseText = input.evidenceText(premise)
    const hypothesisText = input.evidenceText(hypothesis)
    if (!premiseText.trim() || !hypothesisText.trim()
      || digest(premiseText) !== result.premiseHash || digest(hypothesisText) !== result.hypothesisHash) {
      skip('evidence-hash-changed'); continue
    }
    const kind = result.label === 'CONTRADICTION' ? 'contradicts' : 'entails'
    const ordered = kind === 'contradicts' && refKey(premise.ref) > refKey(hypothesis.ref)
      ? [hypothesis.ref, premise.ref] as const : [premise.ref, hypothesis.ref] as const
    const id = `l2-candidate:${digest([GRAPH_L2_TASK_STAGING_VERSION, task.key, kind, ordered])}`
    const observationId = `l2-observation:${digest([id, task.modelId, task.modelRevision,
      task.preprocessingVersion, result.premiseHash, result.hypothesisHash, result.scores])}`
    const sourceHints = uniqueSources([...premise.provenance.sources, ...hypothesis.provenance.sources])
    if (sourceHints.length === 0) { skip('missing-source'); continue }
    const candidate: GraphRelationCandidate = {
      id, scope: premise.scope, from: ordered[0], to: ordered[1], kind, context: premise.context,
      validTime, sourceHints, hypothesisText,
      generator: { route: task.routes[0] ?? 'dense', version: GRAPH_L2_TASK_STAGING_VERSION },
      resolution: task.review?.status === 'rejected'
        ? { status: 'rejected', reason: task.review.reason } : { status: 'pending' },
    }
    const observation: GraphNliObservation = {
      id: observationId, candidateId: id, premise: { kind: 'claim', ref: premise.ref },
      premiseHash: result.premiseHash, hypothesisHash: result.hypothesisHash,
      scores: result.scores, predicted: result.label, modelId: task.modelId,
      modelRevision: task.modelRevision, preprocessingVersion: task.preprocessingVersion,
      truncated: result.truncated, evaluatedAt: result.evaluatedAt,
    }
    const priorCandidate = existingCandidates.get(id)
    const priorObservation = existingObservations.get(observationId)
    if (priorObservation && JSON.stringify(priorObservation) !== JSON.stringify(observation)) {
      skip('observation-content-changed'); continue
    }
    if (priorCandidate) {
      // A task review is not semantic publication. Only pending -> rejected may update staging.
      if (JSON.stringify({ ...priorCandidate, resolution: candidate.resolution }) !== JSON.stringify(candidate)) {
        skip('candidate-content-changed'); continue
      }
      if (priorCandidate.resolution.status === 'pending' && candidate.resolution.status === 'rejected') {
        const index = candidates.findIndex(item => item.id === id)
        candidates[index] = candidate
        existingCandidates.set(id, candidate)
      }
    }
    else {
      candidates.push(candidate)
      existingCandidates.set(id, candidate)
      stagedCandidates++
    }
    if (!priorObservation) {
      observations.push(observation)
      existingObservations.set(observationId, observation)
      stagedObservations++
    }
  }
  if (JSON.stringify([candidates, observations]) === JSON.stringify([current.candidates, current.observations]))
    return { ok: true, value: { manifestId: current.manifest.manifestId,
      stagedCandidates: 0, stagedObservations: 0, skipped } }
  const candidateRevision = current.manifest.candidateRevision + 1
  const manifestId = `l2-stage:${digest([input.core.manifest.manifestId, candidateRevision, candidates, observations])}`
  const next = { ...current, manifest: { ...current.manifest, manifestId, candidateRevision,
    createdAt: Math.max(input.now?.() ?? Date.now(), current.manifest.createdAt), state: 'ready' as const },
  candidates, observations }
  const published = await input.repository.publish({ operationId: `l2-stage:${manifestId}`,
    expectedManifestId: current.manifest.manifestId, snapshot: next })
  return published.ok ? { ok: true, value: { manifestId: published.value.manifestId,
    stagedCandidates, stagedObservations, skipped } } : published
}

function intersection(a: GraphTimeExtent, b: GraphTimeExtent): GraphTimeExtent | undefined {
  if (a.kind === 'unknown' || b.kind === 'unknown') return { kind: 'unknown' }
  const from = a.from === null ? b.from : b.from === null ? a.from : Math.max(a.from, b.from)
  const to = a.to === null ? b.to : b.to === null ? a.to : Math.min(a.to, b.to)
  return from !== null && to !== null && from >= to ? undefined : { kind: 'interval', from, to }
}

function uniqueSources(sources: readonly GraphSourceRef[]): GraphSourceRef[] {
  return [...new Map(sources.map(source => [JSON.stringify(source), source])).values()]
}

function validScores(scores: Readonly<Record<'CONTRADICTION' | 'NEUTRAL' | 'ENTAILMENT', number>>,
  label: 'CONTRADICTION' | 'NEUTRAL' | 'ENTAILMENT'): boolean {
  const values = Object.values(scores)
  return values.length === 3 && values.every(score => Number.isFinite(score) && score >= 0 && score <= 1)
    && Math.abs(values.reduce((sum, score) => sum + score, 0) - 1) <= 0.001
    && scores[label] >= Math.max(...values) - 1e-9
}

function sameScope(a: GraphClaimRecord['scope'], b: GraphClaimRecord['scope']): boolean {
  return a.ownerId === b.ownerId && a.agentId === b.agentId && a.sessionId === b.sessionId
}

function refKey(ref: { kind: string; id: string; version: number }): string {
  return `${ref.kind}\0${ref.id}\0${ref.version}`
}

function digest(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
}

function failure(code: 'stale-projection', message: string): GraphResult<never> {
  return { ok: false, error: { code, message } }
}
