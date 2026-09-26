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
}

export interface FactCandidate {
  id: string
  subjectMentionId: string
  predicate: string
  object: { mentionId: string } | { literal: string }
  evidenceSpan: SourceSpan
  modelScore: number
  context: FactContext
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
  createdAt: number
}

export interface GraphExtractionInput {
  sourceId: string
  sourceText: string
  modelId: string
  rawOutput: unknown
  statusReason?: string
}

/** Retain all UIE output; parse up to a safety budget without graph write filtering. */
export function createGraphExtractionRun(input: GraphExtractionInput): GraphExtractionRun {
  const raw = object(input.rawOutput)
  const graph = object(raw?.graph) ?? raw
  const rawEntities = Array.isArray(graph?.entities) ? graph.entities : []
  const rawFacts = Array.isArray(graph?.facts) ? graph.facts : []
  const unprocessedEntityCount = Math.max(0, rawEntities.length - MAX_PARSED_ITEMS_PER_KIND)
  const unprocessedFactCount = Math.max(0, rawFacts.length - MAX_PARSED_ITEMS_PER_KIND)
  const parsedEntities = rawEntities.slice(0, MAX_PARSED_ITEMS_PER_KIND)
  const parsedFacts = rawFacts.slice(0, MAX_PARSED_ITEMS_PER_KIND)
  const entityMentions = parsedEntities.map(value => parseEntity(value, input.sourceText)).filter(isPresent)
  const entityIds = new Set(entityMentions.map(mention => mention.id))
  const factCandidates = parsedFacts.map(value => parseFact(value, input.sourceText, entityIds)).filter(isPresent)
  const invalidCount = parsedEntities.length - entityMentions.length + parsedFacts.length - factCandidates.length
  const missingGraph = !graph || !Array.isArray(graph.entities) || !Array.isArray(graph.facts)
  const budgetExceeded = unprocessedEntityCount > 0 || unprocessedFactCount > 0
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
    createdAt: Date.now(),
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
}

/** Caller supplies encrypted persistence because source text can be private. */
export function createGraphExtractionResultStore(persistence: GraphExtractionPersistence): GraphExtractionResultStore {
  const payload = persistence.load()
  const parsed = payload ? JSON.parse(payload) as { version?: unknown; runs?: unknown } : undefined
  if (parsed && (parsed.version !== 1 || !Array.isArray(parsed.runs)))
    throw new Error('Invalid graph extraction result store')
  const runs = (parsed?.runs ?? []) as GraphExtractionRun[]
  return {
    append(run) {
      const next = [...runs, run]
      persistence.save(JSON.stringify({ version: 1, runs: next }))
      runs.push(run)
    },
    list: () => [...runs],
    removeSources(sourceIds) {
      const removed = new Set(sourceIds)
      const next = runs.filter(run => !removed.has(run.sourceId))
      persistence.save(JSON.stringify({ version: 1, runs: next }))
      runs.splice(0, runs.length, ...next)
    },
    clear() {
      persistence.save(JSON.stringify({ version: 1, runs: [] }))
      runs.length = 0
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
  return { id: raw.id, type: raw.type, text: raw.text, span: position, modelScore: raw.modelScore }
}

function contextValue<T>(value: unknown, sourceText: string, valid: (value: unknown) => value is T): ResolvedContextValue<T> {
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
    object: typeof mentionId === 'string' ? { mentionId } : { literal: literal as string },
    evidenceSpan: position,
    modelScore: raw.modelScore,
    context: {
      negation: contextValue(context?.negation, sourceText, (v): v is boolean => typeof v === 'boolean'),
      condition: contextValue(context?.condition, sourceText, (v): v is string => typeof v === 'string'),
      time: contextValue(context?.time, sourceText, (v): v is string => typeof v === 'string'),
      speaker: contextValue(context?.speaker, sourceText, (v): v is string => typeof v === 'string'),
    },
  }
}

function isPresent<T>(value: T | undefined): value is T { return value !== undefined }

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
