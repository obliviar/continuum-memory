import { createHash } from 'node:crypto'
import type { MemoryV4Repository } from '../v4/repository/memory-v4-repository'
import type { MemoryEpisodeV4, MemoryFactV4, MemoryFactVersionV4 } from '../v4/domain/types'
import type { GraphExtractionRun, FactCandidate } from './graph-extraction-result'
import type { FactContext } from './graph-extraction-result'
import type { GraphAdmissionDecision } from './graph-admission-review'
import type { GraphEntityRecord, GraphNormalizedFact, GraphPredicateRegistry, GraphTypedValue } from './graph-identity-normalization'
import type { GraphContextFrame } from '../graph-core/domain/types'

export const GRAPH_L1_WRITE_VERSION = 'graph-l1-write-v1'
export type GraphEntityRef = { kind: 'entity'; id: string; version: number }
export type GraphClaimRef = { kind: 'claim'; id: string; version: number }
export type GraphFactRef = { kind: 'v4-fact'; id: string; version: number }
export type GraphSourceRef = { episodeId: string; contentHash: string; locator: { kind: 'text-span'; unit: 'utf16'; start: number; end: number } }
export type GraphGroundTerm = { kind: 'entity'; ref: GraphEntityRef } | GraphTypedValue

/** Structurally compatible with graph-core's GraphClaimRecord. */
export interface GraphClaimRecord {
  ref: GraphClaimRef
  fact: GraphFactRef
  scope: { ownerId: string; agentId: string; sessionId?: string }
  transactionTime: { recordedAt: number; closedAt: number | null }
  provenance: { sources: [GraphSourceRef, ...GraphSourceRef[]]; producer: 'extractor' | 'user'; extractorVersion: string; normalizerVersion: string }
  review: { status: 'accepted'; reviewedAt: number; reviewer: string }
  sensitivity: 'normal' | 'private' | 'secret'
  sharePolicy: 'allow-remote' | 'local-only' | 'ask'
  atom: { predicate: string; args: Record<string, GraphGroundTerm> }
  polarity: 'positive' | 'negative' | 'unknown'
  modality: 'asserted' | 'reported' | 'hypothetical' | 'unknown'
  condition: { kind: 'none' } | { kind: 'unsupported'; text: string; reason: string }
  context: { kind: 'context'; id: string; version: number }
  validTime: { kind: 'unknown' } | { kind: 'interval'; from: number; to: number }
  temporalSource: { value: string | null; resolution: 'resolved' | 'unresolved' | 'absent' }
  evidence: [{ source: GraphSourceRef; role: 'supports'; strength: 'direct' }, ...Array<{ source: GraphSourceRef; role: 'supports'; strength: 'direct' }>]
}

export interface GraphEntityRelationEdge {
  id: string
  from: GraphEntityRef
  to: GraphEntityRef
  predicate: string
  claimRef: GraphClaimRef
  roles: { from: string; to: string }
}

export interface GraphContextRecord {
  ref: { kind: 'context'; id: string; version: number }
  scope: GraphClaimRecord['scope']
  transactionTime: GraphClaimRecord['transactionTime']
  provenance: GraphClaimRecord['provenance']
  review: GraphClaimRecord['review']
  sensitivity: GraphClaimRecord['sensitivity']
  sharePolicy: GraphClaimRecord['sharePolicy']
  domain: 'conversation'
  scenario: 'actual' | 'hypothetical' | 'unknown'
  frame?: GraphContextFrame
  parent: null
}

export interface GraphClaimReview {
  id: string
  runId: string
  sourceFactId: string
  status: 'approved' | 'rejected' | 'pending'
  reason: string
  reviewer: 'policy' | 'user'
  reviewedAt: number
  modelScore: number
  userConfirmed: boolean
  sourceId: string
  sourceRevision: string
  sensitivity: 'normal' | 'private' | 'secret'
  sharePolicy: 'allow-remote' | 'local-only' | 'ask'
  retrieval: { retain: boolean; reason: string }
  proactive: { useAsPreference: boolean; reason: string }
}

/** Separate retrieval value from personal-preference use. No V3 durability filter is consulted. */
export function assessGraphClaim(run: GraphExtractionRun, fact: GraphNormalizedFact,
  privacy: Pick<GraphClaimReview, 'sensitivity' | 'sharePolicy'>,
  now = Date.now()): GraphClaimReview {
  const source = run.factCandidates.find(item => item.id === fact.sourceFactId)
  if (!source)
    throw new Error('Normalized graph fact has no exact extraction source')
  const unresolved = fact.status !== 'ready'
  const evidenceValid = source.evidenceSpan.start >= 0 && source.evidenceSpan.end <= run.sourceText.length
    && source.evidenceSpan.start < source.evidenceSpan.end
  const unsafeContext = source.context.negation.resolution === 'unresolved'
    || source.context.condition.resolution !== 'absent'
    || source.context.speaker.resolution === 'unresolved'
  const status: GraphClaimReview['status'] = !evidenceValid ? 'rejected'
    : run.status !== 'complete' || unresolved || unsafeContext || source.modelScore < 0.75 ? 'pending' : 'approved'
  const reason = !evidenceValid ? 'invalid-evidence-span'
    : run.status !== 'complete' ? 'incomplete-extraction'
      : unresolved ? fact.reason ?? 'unresolved-fact'
      : unsafeContext ? 'context-needs-review'
        : source.modelScore < 0.75 ? 'low-model-score' : 'source-grounded-graph-fact'
  return {
    id: stableId('graph-review', `${run.id}\0${source.id}`), runId: run.id, sourceFactId: source.id,
    status, reason, reviewer: 'policy', reviewedAt: now, modelScore: source.modelScore,
    userConfirmed: false, sourceId: run.sourceId, sourceRevision: run.sourceRevision,
    sensitivity: privacy.sensitivity, sharePolicy: privacy.sharePolicy,
    retrieval: { retain: evidenceValid && !unresolved, reason: evidenceValid && !unresolved ? 'entity-fact-with-evidence' : reason },
    proactive: { useAsPreference: false, reason: 'entity-fact-is-not-a-user-preference' },
  }
}

/** Confirmation changes the review, never overwrites the extraction model score. */
export function confirmGraphClaim(review: GraphClaimReview, reason: string, now = Date.now()): GraphClaimReview {
  if (!reason.trim())
    throw new Error('User confirmation requires a reason')
  if (review.status === 'rejected')
    throw new Error('Rejected evidence cannot be confirmed without a new extraction')
  return { ...review, status: 'approved', reason: reason.trim(), reviewer: 'user', reviewedAt: now,
    userConfirmed: true, retrieval: { retain: true, reason: 'user-confirmed-source-fact' } }
}

export function rejectGraphClaim(review: GraphClaimReview, reason: string, now = Date.now()): GraphClaimReview {
  if (!reason.trim())
    throw new Error('Rejection requires a reason')
  return { ...review, status: 'rejected', reason: reason.trim(), reviewer: 'user', reviewedAt: now,
    userConfirmed: false, retrieval: { retain: false, reason: 'user-rejected' },
    proactive: { useAsPreference: false, reason: 'user-rejected' } }
}

export function deferGraphClaim(review: GraphClaimReview, reason: string, now = Date.now()): GraphClaimReview {
  if (!reason.trim())
    throw new Error('Pending review requires a reason')
  return { ...review, status: 'pending', reason: reason.trim(), reviewer: 'user', reviewedAt: now,
    userConfirmed: false }
}

export function setGraphUseAssessment(review: GraphClaimReview, input: {
  retrievalRetain: boolean
  proactivePreference: boolean
  reason: string
}): GraphClaimReview {
  if (!input.reason.trim())
    throw new Error('Graph use assessment requires a reason')
  if (input.proactivePreference && !review.userConfirmed)
    throw new Error('Proactive preference use requires explicit user confirmation')
  return { ...review,
    retrieval: { retain: input.retrievalRetain, reason: input.reason.trim() },
    proactive: { useAsPreference: input.proactivePreference, reason: input.reason.trim() } }
}

export interface GraphPublicationTask {
  id: string
  run: GraphExtractionRun
  fact: GraphNormalizedFact
  review: GraphClaimReview
  entities: GraphEntityRecord[]
  admission?: GraphAdmissionDecision
  state: 'queued' | 'fact-persisted' | 'published'
  factRef?: GraphFactRef
  attempts: number
  lastError?: string
}

export interface GraphL1Persistence { load: () => string | undefined; save: (payload: string) => void }

export interface GraphL1Store {
  claims: () => GraphClaimRecord[]
  edges: () => GraphEntityRelationEdge[]
  contexts: () => GraphContextRecord[]
  tasks: () => GraphPublicationTask[]
  reviews: () => GraphClaimReview[]
  recordReview: (review: GraphClaimReview) => void
  enqueue: (task: GraphPublicationTask) => void
  updateTask: (task: GraphPublicationTask) => void
  publish: (claim: GraphClaimRecord, edge: GraphEntityRelationEdge | undefined,
    frame: GraphContextFrame, factExists: (ref: GraphFactRef) => boolean) => void
  removeSources: (sourceIds: readonly string[]) => void
  clear: () => void
}

/** Encrypted persistence is supplied by the host; L1 never contains an unbacked Claim. */
export function createGraphL1Store(persistence: GraphL1Persistence): GraphL1Store {
  const raw = persistence.load()
  const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : undefined
  if (parsed && (parsed.version !== 1 || !Array.isArray(parsed.claims) || !Array.isArray(parsed.edges)
    || !Array.isArray(parsed.contexts)
    || !Array.isArray(parsed.tasks) || !Array.isArray(parsed.reviews)))
    throw new Error('Invalid graph L1 store')
  let claims = (parsed?.claims ?? []) as GraphClaimRecord[]
  let edges = (parsed?.edges ?? []) as GraphEntityRelationEdge[]
  let contexts = (parsed?.contexts ?? []) as GraphContextRecord[]
  let tasks = (parsed?.tasks ?? []) as GraphPublicationTask[]
  let reviews = (parsed?.reviews ?? []) as GraphClaimReview[]
  // Old L1 claims used a per-task context. Rebase only those exact legacy IDs;
  // the semantic bundle is rebuilt from this store during the startup retry.
  const taskById = new Map(tasks.map(task => [task.id, task]))
  const frames = new Map<string, GraphContextFrame>()
  const migratedClaims = claims.map(claim => {
    const task = taskById.get(claim.ref.id)
    if (!task || claim.context.id !== stableId('graph-context', task.id)) return claim
    const normalized = normalizedContext(task.run, task.fact.sourceFactId, claim.scope, task.admission?.context)
    frames.set(normalized.ref.id, normalized.frame)
    return { ...claim, context: normalized.ref }
  })
  if (migratedClaims.some((claim, index) => claim !== claims[index])) {
    const migratedContexts = reconcileContexts(migratedClaims, contexts, frames)
    persistence.save(JSON.stringify({ version: 1, claims: migratedClaims, edges, contexts: migratedContexts,
      tasks, reviews }))
    claims = migratedClaims
    contexts = migratedContexts
  }
  const save = (nextClaims: GraphClaimRecord[], nextEdges: GraphEntityRelationEdge[], nextContexts: GraphContextRecord[],
    nextTasks: GraphPublicationTask[], nextReviews: GraphClaimReview[]): void => {
    persistence.save(JSON.stringify({ version: 1, claims: nextClaims, edges: nextEdges, contexts: nextContexts,
      tasks: nextTasks, reviews: nextReviews }))
    claims = nextClaims; edges = nextEdges; contexts = nextContexts; tasks = nextTasks; reviews = nextReviews
  }
  return {
    claims: () => [...claims], edges: () => [...edges], contexts: () => [...contexts],
    tasks: () => [...tasks], reviews: () => [...reviews],
    recordReview(review) { save(claims, edges, contexts, tasks, [...reviews.filter(item => item.id !== review.id), review]) },
    enqueue(task) {
      if (task.review.status !== 'approved')
        throw new Error('Only approved facts may be queued for L1 publication')
      if (!tasks.some(item => item.id === task.id))
        save(claims, edges, contexts, [...tasks, task], reviews)
    },
    updateTask(task) { save(claims, edges, contexts, tasks.map(item => item.id === task.id ? task : item), reviews) },
    publish(claim, edge, frame, factExists) {
      if (!factExists(claim.fact))
        throw new Error('Cannot publish L1 Claim before exact V4 Fact version exists')
      const existing = claims.find(item => item.ref.id === claim.ref.id)
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(claim))
          throw new Error('L1 Claim ID already refers to different content')
        return
      }
      const nextClaims = [...claims, claim]
      save(nextClaims, edge ? [...edges, edge] : edges,
        reconcileContexts(nextClaims, contexts, new Map([[claim.context.id, frame]])), tasks, reviews)
    },
    removeSources(sourceIds) {
      const removed = new Set(sourceIds)
      const removedClaimIds = new Set(tasks.filter(task => removed.has(task.run.sourceId)).map(task => task.id))
      const nextTasks = tasks.filter(task => !removed.has(task.run.sourceId))
      const nextClaims = claims.filter(claim => !removedClaimIds.has(claim.ref.id))
      const claimIds = new Set(nextClaims.map(claim => claim.ref.id))
      save(nextClaims, edges.filter(edge => claimIds.has(edge.claimRef.id)),
        reconcileContexts(nextClaims, contexts), nextTasks,
        reviews.filter(review => !removed.has(review.sourceId)))
    },
    clear() { save([], [], [], [], []) },
  }
}

export interface GraphL1Writer {
  submit: (run: GraphExtractionRun, fact: GraphNormalizedFact, review: GraphClaimReview,
    entities: readonly GraphEntityRecord[], admission?: GraphAdmissionDecision) => Promise<GraphPublicationTask | undefined>
  retryPending: () => Promise<void>
}

export interface GraphL1SemanticPublisher { syncFromClaims: () => Promise<void> }

export function createGraphL1Writer(v4: MemoryV4Repository, l1: GraphL1Store,
  registry: GraphPredicateRegistry, scope: { ownerId: string; agentId: string; sessionId?: string },
  semantic?: GraphL1SemanticPublisher): GraphL1Writer {
  let pending: Promise<void> = Promise.resolve()
  const runTask = async (task: GraphPublicationTask): Promise<GraphPublicationTask> => {
    const current = l1.tasks().find(item => item.id === task.id) ?? task
    if (current.state === 'published')
      return current
    let persisted: GraphPublicationTask | undefined
    try {
      const factRef = current.factRef ?? persistV4Fact(v4, current, registry, scope)
      persisted = { ...current, state: 'fact-persisted', factRef, attempts: current.attempts + 1 }
      l1.updateTask(persisted)
      const { claim, edge, frame } = buildClaim(persisted, factRef, registry, scope)
      l1.publish(claim, edge, frame, (ref) => {
        const snapshot = v4.snapshot()
        return snapshot.factVersions.some(version => version.factId === ref.id && version.version === ref.version)
          && snapshot.facts.some(fact => fact.id === ref.id && fact.status === 'active')
          && claim.provenance.sources.every(source => snapshot.episodes.some(episode =>
            episode.id === source.episodeId && episode.contentState === 'available'
            && episode.contentHash === source.contentHash
            && snapshot.evidenceLinks.some(link => link.factId === ref.id && link.episodeId === episode.id && link.active)))
      })
      await semantic?.syncFromClaims()
      const published = { ...persisted, state: 'published' as const, lastError: undefined }
      l1.updateTask(published)
      return published
    }
    catch (error) {
      const failed = { ...(persisted ?? current), attempts: current.attempts + 1,
        lastError: error instanceof Error ? error.message.slice(0, 300) : 'publication-failed' }
      l1.updateTask(failed)
      return failed
    }
  }
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = pending.then(operation)
    pending = result.then(() => undefined, () => undefined)
    return result
  }
  return {
    submit: (run, fact, review, entities, admission) => serialize(async () => {
      if (fact.runId !== run.id || review.runId !== run.id || review.sourceFactId !== fact.sourceFactId
        || review.sourceId !== run.sourceId || review.sourceRevision !== run.sourceRevision)
        throw new Error('Graph review does not match the exact source candidate')
      if (review.status !== 'approved') {
        // A review is durable before publication eligibility is considered. Replayed
        // policy assessments must not undo a human decision or an existing outbox task.
        const previous = l1.reviews().find(item => item.id === review.id)
        if (!l1.tasks().some(item => item.review.id === review.id)
          && !(previous?.reviewer === 'user' && review.reviewer === 'policy'))
          l1.recordReview(review)
        return undefined
      }
      if (fact.status !== 'ready')
        throw new Error('Approved graph fact still needs identity or predicate resolution')
      if (admission && admission.sourceRevision !== run.sourceRevision)
        throw new Error('Reviewed graph source revision changed')
      const id = stableId('graph-task', `${run.id}\0${fact.sourceFactId}`)
      const task: GraphPublicationTask = { id, run, fact, review, entities: [...entities],
        ...(admission ? { admission } : {}), state: 'queued', attempts: 0 }
      const existing = l1.tasks().find(item => item.id === id)
      if (existing && JSON.stringify([existing.fact, existing.admission]) !== JSON.stringify([fact, admission]))
        throw new Error('Graph publication task already has a different reviewed decision')
      l1.recordReview(review)
      l1.enqueue(task)
      return runTask(task)
    }),
    retryPending: () => serialize(async () => {
      for (const task of l1.tasks().filter(item => item.state !== 'published'))
        await runTask(task)
      await semantic?.syncFromClaims()
    }),
  }
}

function persistV4Fact(v4: MemoryV4Repository, task: GraphPublicationTask, registry: GraphPredicateRegistry,
  scope: GraphClaimRecord['scope']): GraphFactRef {
  const { run, fact, review } = task
  if (createHash('sha256').update(run.sourceText).digest('hex') !== run.sourceRevision)
    throw new Error('Graph source revision does not match exact text')
  const source = sourceFact(run, fact)
  const context = task.admission?.context ?? source.context
  const registration = registry.registrations.find(item => item.spec.name === fact.predicate)
  if (!registration || !fact.arguments)
    throw new Error('Graph fact has no registered predicate arguments')
  const subject = fact.arguments[registration.sourceRole]
  const objectTerm = fact.arguments[registration.targetRole]
  if (subject?.kind !== 'entity' || !objectTerm)
    throw new Error('Graph fact has no resolved subject or object')
  const factId = stableId('graph-fact', task.id)
  const versionId = stableId('graph-version', factId)
  const episodeId = stableId('graph-episode', `${run.sourceId}\0${run.sourceRevision}`)
  const evidenceId = stableId('graph-evidence', `${factId}\0${episodeId}`)
  const now = Math.max(1, review.reviewedAt)
  const object = objectTerm.kind === 'entity' ? objectTerm.entityId : objectTerm.value
  const objectType = objectTerm.kind === 'entity' ? 'entity' : objectTerm.kind
  const canonicalText = run.sourceText.slice(source.evidenceSpan.start, source.evidenceSpan.end)
  const polarity = context.negation.resolution === 'resolved' && context.negation.value === true ? 'negative'
    : context.negation.resolution === 'unresolved' ? 'unknown' : 'positive'
  const modality = context.speaker.resolution === 'resolved' && context.speaker.value !== 'user'
    ? 'reported' : context.condition.resolution === 'resolved' ? 'hypothetical'
      : context.speaker.resolution === 'unresolved' || context.condition.resolution === 'unresolved' ? 'unknown' : 'asserted'
  const condition = context.condition.resolution === 'resolved' && context.condition.value
    ? context.condition.value : undefined
  const validTime = parseDay(context.time.value)
  const priorSnapshot = v4.snapshot()
  if (priorSnapshot.episodes.some(item => item.sourceMessageId === run.sourceId && item.contentState === 'deleted'))
    throw new Error('Deleted source message cannot be republished')
  if (priorSnapshot.facts.some(item => item.id === factId)) {
    if (!priorSnapshot.factVersions.some(version => version.id === versionId))
      throw new Error('Graph V4 Fact is missing its exact version')
    return { kind: 'v4-fact', id: factId, version: 1 }
  }
  v4.transaction((draft) => {
    const existingEpisode = draft.episodes.find(item => item.id === episodeId)
    if (existingEpisode && (existingEpisode.contentState !== 'available' || existingEpisode.contentHash !== run.sourceRevision))
      throw new Error('Graph source episode changed or was deleted')
    if (existingEpisode) {
      const sensitivityRank = { normal: 0, private: 1, secret: 2 }
      const shareRank = { 'allow-remote': 0, ask: 1, 'local-only': 2 }
      if (sensitivityRank[review.sensitivity] > sensitivityRank[existingEpisode.sensitivity])
        existingEpisode.sensitivity = review.sensitivity
      if (shareRank[review.sharePolicy] > shareRank[existingEpisode.sharePolicy])
        existingEpisode.sharePolicy = review.sharePolicy
    }
    if (!existingEpisode) {
      const episode: MemoryEpisodeV4 = {
        id: episodeId, scope, actor: 'user', kind: 'message', contentState: 'available',
        content: run.sourceText, contentHash: run.sourceRevision, recordedAt: now,
        sourceMessageId: run.sourceId, sourceAttachmentIds: [], sensitivity: review.sensitivity,
        sharePolicy: review.sharePolicy, provenance: 'native-v4',
      }
      draft.episodes.push(episode)
    }
    const record: MemoryFactV4 = {
      id: factId, scope, subjectId: subject.entityId, predicate: registration.spec.name,
      object, objectType, normalizedValue: object, canonicalText,
      memoryKey: `${registration.spec.name}:${subject.entityId}`,
      cardinality: registration.spec.cardinality, polarity, modality,
      ...(condition ? { condition } : {}),
      status: 'active', ...(validTime ? { validFrom: validTime.from, validTo: validTime.to } : {}),
      recordedAt: now, updatedAt: now, evidenceLinkIds: [evidenceId],
      extractionScore: review.modelScore, verificationScore: review.userConfirmed ? 1 : 0.8,
      evidenceScore: 1, utilityScore: review.retrieval.retain ? 0.8 : 0.2,
      importance: review.proactive.useAsPreference ? 0.8 : 0.3,
      accessCount: 0, userConfirmed: review.userConfirmed,
      verificationState: 'verified', supersedesFactIds: [], conflictsWithFactIds: [],
      sensitivity: review.sensitivity, sharePolicy: review.sharePolicy,
      origin: review.userConfirmed ? 'manual' : 'automatic',
      metadata: { graphReviewId: review.id, graphTaskId: task.id, modelScore: review.modelScore,
        userConfirmed: review.userConfirmed, retrievalRetain: review.retrieval.retain,
        proactivePreference: review.proactive.useAsPreference,
        sourceTime: context.time.value, timeResolution: context.time.resolution },
      extractorVersion: run.modelId, verifierVersion: GRAPH_L1_WRITE_VERSION,
    }
    const version: MemoryFactVersionV4 = {
      id: versionId, factId, version: 1, operation: 'ADD', subjectId: record.subjectId,
      predicate: record.predicate, object: record.object, objectType: record.objectType,
      normalizedValue: record.normalizedValue, canonicalText, polarity, modality,
      ...(condition ? { condition } : {}), status: 'active',
      ...(validTime ? { validFrom: validTime.from, validTo: validTime.to } : {}),
      evidenceLinkIds: [evidenceId], recordedAt: now, reason: review.reason,
    }
    draft.facts.push(record)
    draft.evidenceLinks.push({ id: evidenceId, factId, episodeId, role: 'supports', strength: 'direct', active: true, createdAt: now })
    draft.factVersions.push(version)
    draft.domainEvents.push({ id: stableId('graph-event', versionId), idempotencyKey: `graph-fact:${versionId}`,
      type: 'FACT_CREATED', scope, factId, episodeId, createdAt: now, actor: review.userConfirmed ? 'user' : 'system',
      payload: { graphTaskId: task.id } })
  })
  return { kind: 'v4-fact', id: factId, version: 1 }
}

function buildClaim(task: GraphPublicationTask, factRef: GraphFactRef, registry: GraphPredicateRegistry,
  scope: GraphClaimRecord['scope']): { claim: GraphClaimRecord; edge?: GraphEntityRelationEdge;
    frame: GraphContextFrame } {
  const { run, fact, review } = task
  const source = sourceFact(run, fact)
  const reviewedContext = task.admission?.context ?? source.context
  const registration = registry.registrations.find(item => item.spec.name === fact.predicate)
  if (!registration || !fact.arguments)
    throw new Error('Graph claim has no registered predicate arguments')
  const entityMap = new Map(task.entities.map(entity => [entity.ref.id, entity.ref]))
  const args: Record<string, GraphGroundTerm> = {}
  for (const [role, term] of Object.entries(fact.arguments)) {
    if (term.kind === 'entity') {
      const ref = entityMap.get(term.entityId)
      if (!ref)
        throw new Error('Graph claim references an entity absent from the reviewed catalog')
      args[role] = { kind: 'entity', ref }
    }
    else { args[role] = term }
  }
  const sourceRef: GraphSourceRef = { episodeId: stableId('graph-episode', `${run.sourceId}\0${run.sourceRevision}`),
    contentHash: run.sourceRevision,
    locator: { kind: 'text-span', unit: 'utf16', ...source.evidenceSpan } }
  const polarity = reviewedContext.negation.resolution === 'resolved' && reviewedContext.negation.value === true ? 'negative'
    : reviewedContext.negation.resolution === 'unresolved' ? 'unknown' : 'positive'
  const modality = reviewedContext.speaker.resolution === 'resolved' && reviewedContext.speaker.value !== 'user'
    ? 'reported' : reviewedContext.condition.resolution === 'resolved' ? 'hypothetical'
      : reviewedContext.speaker.resolution === 'unresolved' || reviewedContext.condition.resolution === 'unresolved' ? 'unknown' : 'asserted'
  const validTime = parseDay(reviewedContext.time.value)
  const claimRef: GraphClaimRef = { kind: 'claim', id: task.id, version: 1 }
  const context = normalizedContext(run, fact.sourceFactId, scope, reviewedContext)
  const claim: GraphClaimRecord = {
    ref: claimRef, fact: factRef, scope,
    transactionTime: { recordedAt: review.reviewedAt, closedAt: null },
    provenance: { sources: [sourceRef], producer: review.userConfirmed ? 'user' : 'extractor',
      extractorVersion: run.modelId, normalizerVersion: GRAPH_L1_WRITE_VERSION },
    review: { status: 'accepted', reviewedAt: review.reviewedAt, reviewer: review.reviewer },
    sensitivity: review.sensitivity, sharePolicy: review.sharePolicy,
    atom: { predicate: registration.spec.name, args }, polarity, modality,
    condition: reviewedContext.condition.resolution === 'resolved' && reviewedContext.condition.value
      ? { kind: 'unsupported', text: reviewedContext.condition.value, reason: 'condition-not-parsed' }
      : { kind: 'none' },
    context: context.ref,
    validTime: validTime ?? { kind: 'unknown' },
    temporalSource: { value: reviewedContext.time.value, resolution: reviewedContext.time.resolution },
    evidence: [{ source: sourceRef, role: 'supports', strength: 'direct' }],
  }
  const from = args[registration.sourceRole]
  const to = args[registration.targetRole]
  const edge: GraphEntityRelationEdge | undefined = from?.kind === 'entity' && to?.kind === 'entity'
    ? { id: stableId('graph-edge', claimRef.id), from: from.ref, to: to.ref,
        predicate: registration.spec.name, claimRef,
        roles: { from: registration.sourceRole, to: registration.targetRole } }
    : undefined
  return { claim, frame: context.frame, ...(edge ? { edge } : {}) }
}

/** Stable across distinct Claims only when the discourse frame is actually known. */
function normalizedContext(run: GraphExtractionRun, sourceFactId: string,
  scope: GraphClaimRecord['scope'], reviewedContext?: FactContext): { ref: GraphClaimRecord['context']; frame: GraphContextFrame } {
  const source = run.factCandidates.find(item => item.id === sourceFactId)
  if (!source) throw new Error('Graph context lost its extraction source')
  const factsContext = reviewedContext ?? source.context
  const conditionText = factsContext.condition.value?.normalize('NFKC').replace(/\s+/gu, ' ').trim()
  const speakerName = factsContext.speaker.value?.normalize('NFKC').replace(/\s+/gu, ' ').trim()
  const condition: GraphContextFrame['condition'] = factsContext.condition.resolution === 'absent'
    ? { kind: 'none' }
    : factsContext.condition.resolution === 'resolved' && conditionText
      ? { kind: 'conditional', text: conditionText } : { kind: 'unknown' }
  const speaker: GraphContextFrame['speaker'] = factsContext.speaker.resolution === 'absent'
    || factsContext.speaker.resolution === 'resolved' && speakerName?.toLowerCase() === 'user'
    ? { kind: 'self' }
    : factsContext.speaker.resolution === 'resolved' && speakerName
      ? { kind: 'reported', name: speakerName } : { kind: 'unknown' }
  const isolation = condition.kind === 'unknown' || speaker.kind === 'unknown' ? 'claim'
    : speaker.kind === 'reported' ? 'source' : 'shared'
  const frame: GraphContextFrame = { speaker, condition, isolation }
  const key = JSON.stringify(['conversation-context-v2', scope.ownerId, scope.agentId, scope.sessionId ?? null,
    frame, isolation === 'claim' ? [run.id, sourceFactId]
      : isolation === 'source' ? [run.sourceId, run.sourceRevision] : null])
  return { ref: { kind: 'context', id: stableId('graph-context', key), version: 1 }, frame }
}

/** Context metadata is a derived aggregate of its live member Claims, not a second fact authority. */
function reconcileContexts(claims: readonly GraphClaimRecord[], previous: readonly GraphContextRecord[],
  frames: ReadonlyMap<string, GraphContextFrame> = new Map()): GraphContextRecord[] {
  const groups = new Map<string, GraphClaimRecord[]>()
  for (const claim of claims) {
    const key = `${claim.context.id}\0${claim.context.version}`
    const group = groups.get(key) ?? []
    group.push(claim)
    groups.set(key, group)
  }
  const old = new Map(previous.map(context => [`${context.ref.id}\0${context.ref.version}`, context]))
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([key, members]) => {
    const ordered = [...members].sort((a, b) => a.transactionTime.recordedAt - b.transactionTime.recordedAt
      || a.ref.id.localeCompare(b.ref.id))
    const first = ordered[0]!
    if (ordered.some(claim => claim.scope.ownerId !== first.scope.ownerId
      || claim.scope.agentId !== first.scope.agentId || claim.scope.sessionId !== first.scope.sessionId))
      throw new Error('Shared graph context crossed memory scopes')
    const prior = old.get(key)
    const frame = frames.get(first.context.id) ?? prior?.frame
    if (!frame && !prior) throw new Error('Graph context frame is unavailable')
    if (frame && prior?.frame && JSON.stringify(frame) !== JSON.stringify(prior.frame))
      throw new Error('Graph context ID refers to different discourse frames')
    const sources = [...new Map(ordered.flatMap(claim => claim.provenance.sources)
      .map(source => [JSON.stringify(source), source])).values()] as GraphClaimRecord['provenance']['sources']
    const sensitivityOrder = ['normal', 'private', 'secret'] as const
    const shareOrder = ['allow-remote', 'ask', 'local-only'] as const
    const sensitivity = ordered.reduce<GraphClaimRecord['sensitivity']>((value, claim) =>
      sensitivityOrder.indexOf(claim.sensitivity) > sensitivityOrder.indexOf(value) ? claim.sensitivity : value,
    'normal')
    const sharePolicy = ordered.reduce<GraphClaimRecord['sharePolicy']>((value, claim) =>
      shareOrder.indexOf(claim.sharePolicy) > shareOrder.indexOf(value) ? claim.sharePolicy : value,
    'allow-remote')
    return { ref: first.context, scope: first.scope,
      transactionTime: { recordedAt: first.transactionTime.recordedAt, closedAt: null },
      provenance: { ...first.provenance, sources,
        normalizerVersion: frame ? 'graph-context-v2' : first.provenance.normalizerVersion },
      review: first.review, sensitivity, sharePolicy, domain: 'conversation',
      scenario: frame ? frame.condition.kind === 'conditional' ? 'hypothetical'
        : frame.condition.kind === 'unknown' ? 'unknown' : 'actual'
        : prior!.scenario, ...(frame ? { frame } : {}), parent: null }
  })
}

function sourceFact(run: GraphExtractionRun, fact: GraphNormalizedFact): FactCandidate {
  const source = run.factCandidates.find(item => item.id === fact.sourceFactId)
  if (!source)
    throw new Error('Graph claim lost its extraction source')
  return source
}

function parseDay(value: string | null): { kind: 'interval'; from: number; to: number } | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/u.test(value))
    return undefined
  const from = Date.parse(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(from) || new Date(from).toISOString().slice(0, 10) !== value)
    return undefined
  return { kind: 'interval', from, to: from + 86_400_000 }
}

function stableId(prefix: string, value: string): string {
  return `${prefix}:${createHash('sha256').update(value).digest('hex').slice(0, 32)}`
}
