import { createHash } from 'node:crypto'
import type { GraphScope, MemorySensitivity } from '@continuum-memory/contracts'
import type { CaptureSnapshot, CaptureSource, CaptureTask } from '../../long-term/capture-repository'
import type { FactCandidate, FactContext, GraphExtractionRun, GraphExtractionResultStore, SourceSpan } from '../../long-term/graph-extraction-result'
import { createGraphPredicateRegistry, type GraphPredicateRegistry } from '../../long-term/graph-identity-normalization'
import { inferMemoryPrivacy } from '../../long-term/memory-extractor'
import type { GraphSemanticBundle } from '../domain/types'
import type { GraphOpenAssertionRecord } from '../domain/open-assertion-types'
import { assessOpenNavigation, backtraceOpenContext, canNavigateOpenAssertion } from './open-assertion-admission'
export type { GraphOpenAssertionRecord } from '../domain/open-assertion-types'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const textHash = (value: string) => createHash('sha256').update(value).digest('hex')
const name = (value: string) => value.normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/gu, '')
const usefulMention = (value: string) => value.length >= 2 && !['我们', '他们', '自己', '用户'].includes(value)
function translatedContext(context: FactContext, offset: number): FactContext {
  const result = structuredClone(context)
  for (const field of Object.values(result))
    if (field.evidenceSpan) field.evidenceSpan = { start: field.evidenceSpan.start + offset, end: field.evidenceSpan.end + offset }
  return result
}

export function needsOpenFactRepresentation(run: GraphExtractionRun, fact: FactCandidate,
  registry: GraphPredicateRegistry = createGraphPredicateRegistry()): boolean {
  const mapped = registry.lookup(fact.predicate)
  if (!mapped) return true
  const { registration, direction } = mapped
  // Basic relations retain all typed roles on the Claim. Observed type labels and
  // binary compatibility anchors must not send an approved n-ary fact back to open-only storage.
  if (registration.spec.registrationKind === 'basic') return false
  const sourceType = registration.spec.roles[direction === 'forward' ? registration.sourceRole : registration.targetRole]?.type
  const targetType = registration.spec.roles[direction === 'forward' ? registration.targetRole : registration.sourceRole]?.type
  if (typeof sourceType === 'object' && sourceType.entityType !== run.entityMentions.find(mention => mention.id === fact.subjectMentionId)?.type)
    return true
  if ('mentionId' in fact.object) {
    const id = fact.object.mentionId
    return typeof targetType !== 'object' || targetType.entityType !== run.entityMentions.find(mention => mention.id === id)?.type
  }
  return typeof targetType === 'object'
}

/** Match the immutable extraction to a current capture, including exact planned segments. */
export function projectOpenAssertions(captures: CaptureSnapshot, store: Pick<GraphExtractionResultStore, 'list' | 'openReviews' | 'publicationView'>,
  scope: GraphScope, options: { includeKnownFacts?: boolean } = {}): GraphOpenAssertionRecord[] {
  const result = new Map<string, GraphOpenAssertionRecord>()
  const reviews = new Map(store.openReviews().map(review => [review.assertionId, review]))
  const registry = createGraphPredicateRegistry()
  const sourcesById = new Map<string, CaptureSource[]>()
  const tasksBySource = new Map<string, CaptureTask[]>()
  for (const source of captures.sources) {
    const text = source.turn?.userMessage
    if (source.status !== 'active' || !text || source.scope.ownerId !== scope.ownerId || source.scope.agentId !== scope.agentId
      || (scope.sessionId !== undefined && source.scope.sessionId !== scope.sessionId)
      || source.contentHash !== hash([text, source.turn?.attachments ?? []])) continue
    for (const id of new Set([source.id, ...source.messageIds])) {
      const records = sourcesById.get(id) ?? []
      records.push(source); sourcesById.set(id, records)
    }
  }
  for (const task of captures.tasks) {
    const records = tasksBySource.get(task.sourceId) ?? []
    records.push(task); tasksBySource.set(task.sourceId, records)
  }
  for (const rawRun of store.list()) {
    const view = store.publicationView?.(rawRun.id)
    const evidenceLive = view?.supplementalEvidence?.length && view.supplementalEvidence.every(extra =>
      textHash(extra.text) === extra.sourceRevision && (sourcesById.get(extra.sourceId) ?? []).some(source =>
        source.turn?.userMessage === extra.text && inferMemoryPrivacy(extra.text).sensitivity === 'normal'))
    const run = evidenceLive ? view! : rawRun
    if (run.status !== 'complete' || textHash(run.sourceText) !== run.sourceRevision) continue
    const matched = (sourcesById.get(run.sourceId) ?? []).flatMap(source => {
      const text = source.turn!.userMessage
      const offsets = text === run.sourceText ? [0] : (tasksBySource.get(source.id) ?? [])
        .filter(task => text.slice(task.start, task.end) === run.sourceText).map(task => task.start)
      return [...new Set(offsets)].map(offset => ({ source, offset, text }))
    })
    // Identical message IDs from different sessions must not silently bind to one source.
    if (matched.length !== 1) continue
    const { source, offset, text } = matched[0]!
    const mentions = new Map(run.entityMentions.map(mention => [mention.id, mention]))
    const candidates = [...(run.assertionCandidates ?? []).map(candidate => ({ ...candidate, attributes: [] as GraphOpenAssertionRecord['attributes'] })),
      ...run.factCandidates.filter(fact => options.includeKnownFacts || needsOpenFactRepresentation(run, fact, registry))
      .map(fact => ({ id: fact.id, relationText: fact.predicate, evidenceSpan: fact.evidenceSpan,
        modelScore: fact.modelScore, context: fact.context,
        participants: [{ mentionId: fact.subjectMentionId, role: 'subject' },
          ...('mentionId' in fact.object ? [{ mentionId: fact.object.mentionId, role: 'object' }] : [])],
        attributes: 'literal' in fact.object ? [{ role: 'object', value: fact.object.literal, typeCandidate: fact.object.valueType ?? 'string' }] : [],
      }))]
    for (const candidate of candidates) {
      const span = candidate.evidenceSpan
      if (!validSpan(span, run.sourceText) || !candidate.relationText.trim()) continue
      const participants = candidate.participants.map(participant => {
        const mention = mentions.get(participant.mentionId)
        if (!mention || !validSpan(mention.span, run.sourceText) || run.sourceText.slice(mention.span.start, mention.span.end) !== mention.text
          || mention.span.start < span.start || mention.span.end > span.end) return undefined
        const translated = { start: mention.span.start + offset, end: mention.span.end + offset }
        return { ref: { kind: 'mention' as const, id: `open-mention:${hash([source.id, source.revision, translated])}`, version: 1 as const },
          text: mention.text, ...(evidenceLive && mention.resolvedText
            && run.supplementalEvidence?.some(extra => extra.text.includes(mention.resolvedText!))
            ? { resolvedText: mention.resolvedText } : {}), role: participant.role, typeCandidate: mention.type, span: translated }
      })
      if (!participants.length || participants.some(participant => !participant)) continue
      const evidenceSpan = { start: span.start + offset, end: span.end + offset }
      const context = translatedContext(candidate.context, offset)
      const id = `open-assertion:${hash([source.id, source.revision, evidenceSpan, candidate.relationText,
        participants, candidate.attributes, context])}`
      const review = reviews.get(id)
      const exactReview = review?.sourceId === run.sourceId && review.sourceRevision === run.sourceRevision ? review : undefined
      const relationSpan = 'relationSpan' in candidate && candidate.relationSpan
        ? { start: candidate.relationSpan.start + offset, end: candidate.relationSpan.end + offset } : undefined
      const record: GraphOpenAssertionRecord = { ref: { kind: 'open-assertion', id, version: 1 },
        scope: { ownerId: scope.ownerId, agentId: scope.agentId, ...(source.scope.sessionId ? { sessionId: source.scope.sessionId } : {}) },
        source: { captureId: source.id, revision: source.revision, contentHash: source.contentHash },
        extraction: { sourceId: run.sourceId, sourceRevision: run.sourceRevision, modelId: run.modelId, runId: run.id, candidateId: candidate.id },
        relationText: candidate.relationText, ...(relationSpan ? { relationSpan } : {}), evidenceSpan,
        text: text.slice(evidenceSpan.start, evidenceSpan.end), participants: participants as GraphOpenAssertionRecord['participants'],
        attributes: candidate.attributes, context: exactReview?.context ? translatedContext(exactReview.context, offset) : context,
        sourceContext: backtraceOpenContext(text, evidenceSpan),
        review: exactReview ? { status: exactReview.status, reason: exactReview.reason, reviewedAt: exactReview.reviewedAt } : { status: 'candidate' },
        modelScore: candidate.modelScore, sensitivity: inferMemoryPrivacy(text).sensitivity, sharePolicy: 'local-only', inferenceAllowed: false }
      const previous = result.get(id)
      const admitted = { ...record, admission: assessOpenNavigation(record) }
      if (!previous || previous.modelScore <= record.modelScore) result.set(id, admitted)
    }
  }
  return [...result.values()].sort((a, b) => a.ref.id.localeCompare(b.ref.id))
}

function validSpan(span: SourceSpan, source: string): boolean {
  return Number.isSafeInteger(span.start) && Number.isSafeInteger(span.end) && span.start >= 0
    && span.end > span.start && span.end <= source.length
    && ![span.start, span.end].some(i => /[\uD800-\uDBFF]/u.test(source[i - 1] ?? '') && /[\uDC00-\uDFFF]/u.test(source[i] ?? ''))
}

export interface OpenAssertionSearchHit {
  assertion: GraphOpenAssertionRecord
  depth: number
  route: 'text-match' | 'mention-text-candidate' | 'context-vector-candidate'
  /** Similarity ranks relevance only, not identity or factual correctness. */
  contextSimilarity?: number
  verification?: 'user-confirmed' | 'automatic-navigation' | 'unverified-candidate'
  via?: { assertionId: string; mentionText: string; contextSimilarity?: number }
}

/** Local navigation. Matching mention text proposes relevance, never sameAs or a proof. */
export function searchOpenAssertions(bundle: Pick<GraphSemanticBundle, 'openAssertions'>, query: string,
  options: { scope: GraphScope; maximumDepth?: number; limit?: number; sensitivities?: readonly MemorySensitivity[];
    includeCandidates?: boolean; seedAssertionIds?: readonly string[] }): OpenAssertionSearchHit[] {
  const needle = name(query)
  if (!needle) return []
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(100, Math.floor(options.limit!))) : 20
  const depthLimit = Number.isFinite(options.maximumDepth) ? Math.max(0, Math.min(3, Math.floor(options.maximumDepth!))) : 1
  const sensitivities = options.sensitivities ?? ['normal', 'private', 'secret']
  const records = (bundle.openAssertions ?? []).filter(record => record.review.status !== 'rejected'
    && (canNavigateOpenAssertion(record) || options.includeCandidates)
    && record.scope.ownerId === options.scope.ownerId && record.scope.agentId === options.scope.agentId
    && (options.scope.sessionId === undefined || options.scope.sessionId === record.scope.sessionId)
    && sensitivities.includes(record.sensitivity))
  const hits = new Map<string, OpenAssertionSearchHit>()
  const verification = (record: GraphOpenAssertionRecord): OpenAssertionSearchHit['verification'] =>
    record.review.status === 'accepted' ? 'user-confirmed' : canNavigateOpenAssertion(record) ? 'automatic-navigation' : 'unverified-candidate'
  const queue = records.filter(record => options.seedAssertionIds ? options.seedAssertionIds.includes(record.ref.id)
    : name(record.text).includes(needle) || needle.includes(name(record.text))
    || name(record.relationText).includes(needle)
    || record.participants.some(participant => [participant.text, participant.resolvedText].some(text => text
      && usefulMention(name(text)) && (needle.includes(name(text)) || name(text).includes(needle)))))
    .slice(0, limit).map(assertion => ({ assertion, depth: 0, route: 'text-match' as const, verification: verification(assertion) }))
  for (const hit of queue) hits.set(hit.assertion.ref.id, hit)
  const frontier: OpenAssertionSearchHit[] = [...queue]
  const mentions = new Map<string, GraphOpenAssertionRecord[]>()
  for (const record of records) for (const participant of record.participants) {
    const key = name(participant.text)
    if (!usefulMention(key)) continue
    const entries = mentions.get(key) ?? []
    entries.push(record); mentions.set(key, entries)
  }
  for (let i = 0; i < frontier.length && hits.size < limit; i++) {
    const hit = frontier[i]!
    if (hit.depth >= depthLimit) continue
    for (const participant of hit.assertion.participants) {
      for (const neighbor of mentions.get(name(participant.text)) ?? []) {
        if (hits.has(neighbor.ref.id)) continue
        const compatible = neighbor.participants.some(other => name(other.text) === name(participant.text)
          && (other.typeCandidate === 'unknown' || participant.typeCandidate === 'unknown' || other.typeCandidate === participant.typeCandidate))
        if (!compatible) continue
        const next: OpenAssertionSearchHit = { assertion: neighbor, depth: hit.depth + 1, route: 'mention-text-candidate',
          verification: verification(neighbor), via: { assertionId: hit.assertion.ref.id, mentionText: participant.text } }
        hits.set(neighbor.ref.id, next); frontier.push(next)
        if (hits.size >= limit) break
      }
      if (hits.size >= limit) break
    }
  }
  return structuredClone([...hits.values()])
}
