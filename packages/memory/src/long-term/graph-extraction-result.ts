import { createHash, randomUUID } from 'node:crypto'

/** Versioned, source-aligned UIE output retained before graph write policy runs. */
export const GRAPH_EXTRACTION_SCHEMA_VERSION = 'graph-extraction-v1'
const MAX_PARSED_ITEMS_PER_KIND = 1_000

export interface SourceSpan {
  /** UTF-16 offsets into the exact source revision, end exclusive. */
  start: number
  end: number
}

export interface EntityMention {
  id: string
  type: string
  text: string
  span: SourceSpan
  modelScore: number
  resolvedText?: string
}

export interface ResolvedContextValue<T> {
  value: T | null
  resolution: 'resolved' | 'unresolved' | 'absent'
  evidenceSpan?: SourceSpan
}

export interface FactContext {
  negation: ResolvedContextValue<boolean>
  condition: ResolvedContextValue<string>
  time: ResolvedContextValue<string>
  speaker: ResolvedContextValue<string>
  modality?: ResolvedContextValue<'asserted' | 'planned' | 'hypothetical' | 'reported' | 'unknown'>
}

export interface FactCandidate {
  id: string
  subjectMentionId: string
  predicate: string
  object: { mentionId: string } | { literal: string; valueType?: 'string' | 'number' | 'date' | 'boolean' | 'amount'; unit?: string }
  evidenceSpan: SourceSpan
  modelScore: number
  context: FactContext
  /** Derived publication fields; retained raw extraction is never rewritten. */
  relationText?: string
  relationSpan?: SourceSpan
  participants?: { mentionId: string; role: string }[]
  sourceAssertionId?: string
  registrationKind?: 'basic'
  roleMapping?: Record<string, string>
  mappingId?: string
}

/** A source assertion can have any relation label and any number of participants. */
export interface OpenAssertionCandidate {
  id: string
  relationText: string
  relationSpan?: SourceSpan
  participants: { mentionId: string; role: string }[]
  evidenceSpan: SourceSpan
  modelScore: number
  context: FactContext
}

export interface OpenAssertionReview {
  assertionId: string
  sourceId: string
  sourceRevision: string
  status: 'accepted' | 'rejected'
  reason: string
  reviewedAt: number
  context?: FactContext
}

export interface GraphExtractionRun {
  id: string
  sourceId: string
  sourceRevision: string
  sourceText: string
  modelId: string
  schemaVersion: typeof GRAPH_EXTRACTION_SCHEMA_VERSION
  status: 'complete' | 'incomplete' | 'failed'
  statusReason?: string
  unprocessedEntityCount?: number
  unprocessedFactCount?: number
  /** The untouched, parsed UIE payload; conversion never mutates this value. */
  rawOutput: unknown
  entityMentions: EntityMention[]
  factCandidates: FactCandidate[]
  /** Optional for extraction snapshots written before open assertions. */
  assertionCandidates?: OpenAssertionCandidate[]
  createdAt: number
  /** Independent, source-backed user clarification. Never concatenated into sourceText. */
  supplementalEvidence?: { sourceId: string; sourceRevision: string; text: string }[]
  relationSenses?: Record<string, string>
  remoteExtraction?: boolean
  /** Host-generated semantic review receipt; never parsed from extractor output. */
  semanticReview?: { version: string; runId: string; candidateIds: string[]; contextVersion?: string }
}

export interface GraphExtractionInput {
  sourceId: string
  sourceText: string
  modelId: string
  rawOutput: unknown
  statusReason?: string
  /** Open-model output must ground its arbitrary relation label in an exact span. */
  requireRelationSpan?: boolean
  remoteExtraction?: boolean
}

/** Retain all UIE output; parse up to a safety budget without graph write filtering. */
export function createGraphExtractionRun(input: GraphExtractionInput): GraphExtractionRun {
  const raw = object(input.rawOutput)
  const graph = object(raw?.graph) ?? raw
  const rawEntities = Array.isArray(graph?.entities) ? graph.entities : []
  const rawFacts = Array.isArray(graph?.facts) ? graph.facts : []
  const rawAssertions = Array.isArray(graph?.assertions) ? graph.assertions : []
  const unprocessedEntityCount = Math.max(0, rawEntities.length - MAX_PARSED_ITEMS_PER_KIND)
  const unprocessedFactCount = Math.max(0, rawFacts.length - MAX_PARSED_ITEMS_PER_KIND)
  const parsedEntities = rawEntities.slice(0, MAX_PARSED_ITEMS_PER_KIND)
  const parsedFacts = rawFacts.slice(0, MAX_PARSED_ITEMS_PER_KIND)
  const entityMentions = parsedEntities.map(value => parseEntity(value, input.sourceText)).filter(isPresent)
  const entityIds = new Set(entityMentions.map(mention => mention.id))
  const entityById = new Map(entityMentions.map(mention => [mention.id, mention]))
  const factCandidates = parsedFacts.map(value => parseFact(value, input.sourceText, entityIds)).filter(isPresent)
  const assertionCandidates = rawAssertions.slice(0, MAX_PARSED_ITEMS_PER_KIND)
    .map(value => parseAssertion(value, input.sourceText, entityById, input.requireRelationSpan)).filter(isPresent)
  const invalidCount = parsedEntities.length - entityMentions.length + parsedFacts.length - factCandidates.length
    + Math.min(rawAssertions.length, MAX_PARSED_ITEMS_PER_KIND) - assertionCandidates.length
  const missingGraph = !graph || !Array.isArray(graph.entities) || !Array.isArray(graph.facts)
  const budgetExceeded = unprocessedEntityCount > 0 || unprocessedFactCount > 0 || rawAssertions.length > MAX_PARSED_ITEMS_PER_KIND
  return {
    id: randomUUID(),
    sourceId: input.sourceId,
    sourceRevision: createHash('sha256').update(input.sourceText).digest('hex'),
    sourceText: input.sourceText,
    modelId: input.modelId,
    schemaVersion: GRAPH_EXTRACTION_SCHEMA_VERSION,
    status: missingGraph || invalidCount > 0 || budgetExceeded || input.statusReason ? 'incomplete' : 'complete',
    ...(missingGraph || invalidCount > 0 || budgetExceeded || input.statusReason
      ? { statusReason: input.statusReason ?? (missingGraph ? 'missing-uie-structure'
        : budgetExceeded ? 'uie-parse-budget-exhausted' : `invalid-items:${invalidCount}`) }
      : {}),
    ...(unprocessedEntityCount ? { unprocessedEntityCount } : {}),
    ...(unprocessedFactCount ? { unprocessedFactCount } : {}),
    rawOutput: input.rawOutput,
    entityMentions,
    factCandidates,
    assertionCandidates,
    createdAt: Date.now(),
    ...(input.remoteExtraction ? { remoteExtraction: true } : {}),
  }
}

export interface GraphExtractionPersistence {
  load: () => string | undefined
  save: (payload: string) => void
}

export interface GraphExtractionResultStore {
  append: (run: GraphExtractionRun) => void
  list: () => GraphExtractionRun[]
  removeSources: (sourceIds: string[]) => void
  clear: () => void
  openReviews: () => OpenAssertionReview[]
  publicationView?: (runId: string) => GraphExtractionRun | undefined
  savePublicationView?: (run: GraphExtractionRun) => void
  recordOpenReview: (review: OpenAssertionReview) => void
}

/** Caller supplies encrypted persistence because source text can be private. */
export function createGraphExtractionResultStore(persistence: GraphExtractionPersistence): GraphExtractionResultStore {
  const payload = persistence.load()
  const parsed = payload ? JSON.parse(payload) as { version?: unknown; runs?: unknown; openReviews?: OpenAssertionReview[]; publicationViews?: GraphExtractionRun[] } : undefined
  if (parsed && (parsed.version !== 1 || !Array.isArray(parsed.runs)
    || (parsed.openReviews !== undefined && !Array.isArray(parsed.openReviews))))
    throw new Error('Invalid graph extraction result store')
  const runs = (parsed?.runs ?? []) as GraphExtractionRun[]
  let reviews = parsed?.openReviews ?? []
  let publicationViews = parsed?.publicationViews ?? []
  const save = (nextRuns: GraphExtractionRun[], nextReviews: OpenAssertionReview[]) =>
    persistence.save(JSON.stringify({ version: 1, runs: nextRuns, openReviews: nextReviews, publicationViews }))
  return {
    append(run) {
      const next = [...runs, run]
      save(next, reviews)
      runs.push(structuredClone(run))
    },
    list: () => structuredClone(runs),
    publicationView: runId => structuredClone(publicationViews.find(view => view.id === runId)),
    savePublicationView(run) {
      const raw = runs.find(item => item.id === run.id)
      if (!raw || raw.sourceId !== run.sourceId || raw.sourceRevision !== run.sourceRevision
        || raw.sourceText !== run.sourceText || run.semanticReview?.runId !== run.id)
        throw new Error('Publication view must match its retained source and semantic review')
      const next = { ...raw, entityMentions: run.entityMentions, supplementalEvidence: run.supplementalEvidence,
        semanticReview: run.semanticReview,
        factCandidates: raw.factCandidates.map(f => ({ ...f, context: run.factCandidates.find(view => view.id === f.id)?.context ?? f.context })),
        assertionCandidates: raw.assertionCandidates?.map(a => ({ ...a, context: run.assertionCandidates?.find(view => view.id === a.id)?.context ?? a.context })) }
      const previous = publicationViews
      publicationViews = [...previous.filter(item => item.id !== run.id), structuredClone(next)]
      try { save(runs, reviews) } catch (error) { publicationViews = previous; throw error }
    },
    openReviews: () => structuredClone(reviews),
    recordOpenReview(review) {
      if (!review.assertionId || !review.reason.trim() || !['accepted', 'rejected'].includes(review.status)
        || !Number.isSafeInteger(review.reviewedAt) || review.reviewedAt < 1
        || !runs.some(run => run.sourceId === review.sourceId && run.sourceRevision === review.sourceRevision))
        throw new Error('Open assertion review needs an exact retained extraction source')
      const next = [...reviews.filter(item => item.assertionId !== review.assertionId), structuredClone(review)]
      save(runs, next)
      reviews = next
    },
    removeSources(sourceIds) {
      const removed = new Set(sourceIds)
      const next = runs.filter(run => !removed.has(run.sourceId))
      const nextReviews = reviews.filter(review => !removed.has(review.sourceId))
      publicationViews = publicationViews.filter(view => !removed.has(view.sourceId)
        && !view.supplementalEvidence?.some(extra => removed.has(extra.sourceId)))
      save(next, nextReviews)
      runs.splice(0, runs.length, ...next)
      reviews = nextReviews
    },
    clear() {
      publicationViews = []
      save([], [])
      runs.length = 0
      reviews = []
    },
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function span(value: unknown, sourceText: string): SourceSpan | undefined {
  const raw = object(value)
  const start = raw?.start
  const end = raw?.end
  return Number.isInteger(start) && Number.isInteger(end)
    && (start as number) >= 0 && (end as number) > (start as number)
    && (end as number) <= sourceText.length
    ? { start: start as number, end: end as number } : undefined
}

function score(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

function parseEntity(value: unknown, sourceText: string): EntityMention | undefined {
  const raw = object(value)
  const position = span(raw?.span, sourceText)
  if (!raw || typeof raw.id !== 'string' || !raw.id || typeof raw.type !== 'string' || !raw.type
    || typeof raw.text !== 'string' || !position || sourceText.slice(position.start, position.end) !== raw.text
    || !score(raw.modelScore))
    return undefined
  return { id: raw.id, type: raw.type, text: raw.text, span: position, modelScore: raw.modelScore,
    ...(typeof raw.resolvedText === 'string' && raw.resolvedText.trim() && raw.resolvedText.length <= 150 ? { resolvedText: raw.resolvedText.trim() } : {}) }
}

function contextValue<T>(value: unknown, sourceText: string, valid: (value: unknown) => value is T): ResolvedContextValue<T> {
  // Some compatible APIs emit scalar qualifiers even when the prompt requests
  // structured values. Preserve explicit false/planned; omission remains unknown.
  if (value === null) return { value: null, resolution: 'absent' }
  if (valid(value)) return { value, resolution: 'resolved' }
  const raw = object(value)
  const resolution = raw?.resolution
  if (raw && resolution === 'resolved' && valid(raw.value)) {
    const evidenceSpan = span(raw.evidenceSpan, sourceText)
    return { value: raw.value, resolution, ...(evidenceSpan ? { evidenceSpan } : {}) }
  }
  return { value: null, resolution: resolution === 'absent' ? 'absent' : 'unresolved' }
}

function parseFact(value: unknown, sourceText: string, entityIds: Set<string>): FactCandidate | undefined {
  const raw = object(value)
  const position = span(raw?.evidenceSpan, sourceText)
  const objectValue = object(raw?.object)
  const mentionId = objectValue?.mentionId
  const literal = objectValue?.literal
  if (!raw || typeof raw.id !== 'string' || !raw.id
    || typeof raw.subjectMentionId !== 'string' || !entityIds.has(raw.subjectMentionId)
    || typeof raw.predicate !== 'string' || !raw.predicate
    || !position || !score(raw.modelScore)
    || !(typeof mentionId === 'string' && entityIds.has(mentionId) || typeof literal === 'string'))
    return undefined
  const context = object(raw.context)
  return {
    id: raw.id,
    subjectMentionId: raw.subjectMentionId,
    predicate: raw.predicate,
    object: typeof mentionId === 'string' ? { mentionId } : {
      literal: literal as string,
      ...(objectValue?.valueType === 'string' || objectValue?.valueType === 'number'
        || objectValue?.valueType === 'date' || objectValue?.valueType === 'boolean'
        || objectValue?.valueType === 'amount' ? { valueType: objectValue.valueType } : {}),
      ...(typeof objectValue?.unit === 'string' && objectValue.unit.trim()
        ? { unit: objectValue.unit.trim() } : {}),
    },
    evidenceSpan: position,
    modelScore: raw.modelScore,
    context: {
      negation: contextValue(context?.negation, sourceText, (v): v is boolean => typeof v === 'boolean'),
      condition: contextValue(context?.condition, sourceText, (v): v is string => typeof v === 'string'),
      time: contextValue(context?.time, sourceText, (v): v is string => typeof v === 'string'),
      speaker: contextValue(context?.speaker, sourceText, (v): v is string => typeof v === 'string'),
      ...(context?.modality ? { modality: contextValue(context.modality, sourceText, (v): v is NonNullable<FactContext['modality']>['value'] & string =>
        typeof v === 'string' && ['asserted', 'planned', 'hypothetical', 'reported', 'unknown'].includes(v)) } : {}),
    },
  }
}

function isPresent<T>(value: T | undefined): value is T { return value !== undefined }

function parseAssertion(value: unknown, sourceText: string, entities: Map<string, EntityMention>, requireRelationSpan = false): OpenAssertionCandidate | undefined {
  const raw = object(value)
  const evidenceSpan = span(raw?.evidenceSpan, sourceText)
  if (!raw || typeof raw.id !== 'string' || !raw.id || typeof raw.relationText !== 'string'
    || !raw.relationText.trim() || raw.relationText.length > 200 || !evidenceSpan || !score(raw.modelScore)
    || !Array.isArray(raw.participants) || raw.participants.length < 1 || raw.participants.length > 32) return undefined
  const participants: OpenAssertionCandidate['participants'] = []
  for (const item of raw.participants) {
    const participant = object(item)
    if (!participant || typeof participant.mentionId !== 'string' || !entities.has(participant.mentionId)
      || typeof participant.role !== 'string' || !participant.role.trim() || participant.role.length > 100) return undefined
    const mention = entities.get(participant.mentionId)!
    if (mention.span.start < evidenceSpan.start || mention.span.end > evidenceSpan.end) return undefined
    participants.push({ mentionId: participant.mentionId, role: participant.role })
  }
  const relationSpan = raw.relationSpan === undefined ? undefined : span(raw.relationSpan, sourceText)
  if (requireRelationSpan && !relationSpan) return undefined
  if (raw.relationSpan !== undefined && (!relationSpan || sourceText.slice(relationSpan.start, relationSpan.end) !== raw.relationText
    || relationSpan.start < evidenceSpan.start || relationSpan.end > evidenceSpan.end)) return undefined
  const context = object(raw.context)
  return { id: raw.id, relationText: raw.relationText, ...(relationSpan ? { relationSpan } : {}), participants,
    evidenceSpan, modelScore: raw.modelScore, context: {
      negation: contextValue(context?.negation, sourceText, (v): v is boolean => typeof v === 'boolean'),
      condition: contextValue(context?.condition, sourceText, (v): v is string => typeof v === 'string'),
      time: contextValue(context?.time, sourceText, (v): v is string => typeof v === 'string'),
      speaker: contextValue(context?.speaker, sourceText, (v): v is string => typeof v === 'string'),
      ...(context?.modality ? { modality: contextValue(context.modality, sourceText, (v): v is NonNullable<FactContext['modality']>['value'] & string =>
        typeof v === 'string' && ['asserted', 'planned', 'hypothetical', 'reported', 'unknown'].includes(v)) } : {}),
    } }
}

export interface GraphWritePolicy {
  minimumModelScore: number
  maximumFacts: number
}

export const DEFAULT_GRAPH_WRITE_POLICY: GraphWritePolicy = {
  minimumModelScore: 0.75,
  maximumFacts: 8,
}

export interface GraphWriteSelection {
  selected: FactCandidate[]
  belowThreshold: number
  deferred: number
  status: 'complete' | 'incomplete'
  statusReason?: string
}

/** Selection is downstream of durable extraction storage. */
export function selectGraphWriteCandidates(
  run: GraphExtractionRun,
  policy: GraphWritePolicy = DEFAULT_GRAPH_WRITE_POLICY,
): GraphWriteSelection {
  const eligible = run.factCandidates.filter(fact => fact.modelScore >= policy.minimumModelScore)
  const maximum = Math.max(0, Math.floor(policy.maximumFacts))
  return {
    selected: eligible.slice(0, maximum),
    belowThreshold: run.factCandidates.length - eligible.length,
    deferred: Math.max(0, eligible.length - maximum),
    status: eligible.length > maximum ? 'incomplete' : 'complete',
    ...(eligible.length > maximum ? { statusReason: 'graph-write-budget-exhausted' } : {}),
  }
}
