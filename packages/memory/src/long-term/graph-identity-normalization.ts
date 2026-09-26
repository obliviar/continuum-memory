import type { EntityMention, FactCandidate, FactContext, GraphExtractionRun, SourceSpan } from './graph-extraction-result'

/** Structural views of graph-core's records. Full GraphEntityRecord values are assignable. */
export interface GraphEntityRecord {
  readonly ref: { readonly kind: 'entity'; readonly id: string; readonly version: number }
  readonly scope: { readonly ownerId: string; readonly agentId: string; readonly sessionId?: string }
  readonly entityType: string
  readonly canonicalName: string
  readonly aliases: readonly string[]
  readonly review?: { readonly status: string }
}

/** Only accepted identity decisions affect resolution. A split cancels a merge. */
export interface GraphAliasDecision {
  readonly ref: { readonly kind: 'alias-decision'; readonly id: string; readonly version: number }
  readonly action: 'merge' | 'split'
  readonly members: readonly { readonly kind: 'entity'; readonly id: string; readonly version: number }[]
  readonly canonical: { readonly kind: 'entity'; readonly id: string; readonly version: number }
  readonly review: { readonly status: string }
  readonly transactionTime: { readonly recordedAt: number }
}

export type GraphValueType = 'string' | 'number' | 'boolean' | 'date' | { readonly entityType: string }

/** Shape compatible with graph-core's GraphPredicateSpec. Roles encode direction. */
export interface GraphPredicateSpec {
  readonly ref: { readonly kind: 'predicate'; readonly id: string; readonly version: number }
  readonly name: string
  readonly roles: Readonly<Record<string, { readonly type: GraphValueType; readonly required: boolean }>>
  readonly cardinality: 'single' | 'multiple' | 'set'
  readonly keyRoles: readonly string[]
  readonly valueRole: string | null
  readonly symmetry: 'none' | 'symmetric'
  readonly transitivity: 'none' | 'approved'
  readonly inferenceAllowed: boolean
  readonly world: 'open'
}

export interface GraphPredicateRegistration {
  readonly spec: GraphPredicateSpec
  readonly sourceRole: string
  readonly targetRole: string
  readonly labels: readonly { readonly text: string; readonly direction: 'forward' | 'reverse' }[]
  readonly literalFormat?: 'amount'
}

export interface GraphPredicateRegistry {
  readonly registrations: readonly GraphPredicateRegistration[]
  lookup: (label: string) => { registration: GraphPredicateRegistration; direction: 'forward' | 'reverse' } | undefined
}

function spec(name: string, sourceRole: string, sourceType: GraphValueType, targetRole: string,
  targetType: GraphValueType, cardinality: GraphPredicateSpec['cardinality']): GraphPredicateSpec {
  return {
    ref: { kind: 'predicate', id: name, version: 1 }, name,
    roles: { [sourceRole]: { type: sourceType, required: true }, [targetRole]: { type: targetType, required: true } },
    cardinality, keyRoles: [sourceRole], valueRole: targetRole,
    symmetry: 'none', transitivity: 'none', inferenceAllowed: false, world: 'open',
  }
}

export const DEFAULT_GRAPH_PREDICATES: readonly GraphPredicateRegistration[] = [
  {
    spec: spec('worksAt', 'person', { entityType: 'person' }, 'organization', { entityType: 'organization' }, 'multiple'),
    sourceRole: 'person', targetRole: 'organization',
    labels: [
      { text: 'worksAt', direction: 'forward' }, { text: 'works at', direction: 'forward' },
      { text: '工作于', direction: 'forward' }, { text: '任职于', direction: 'forward' },
      { text: 'employs', direction: 'reverse' }, { text: '雇佣', direction: 'reverse' },
    ],
  },
  {
    spec: spec('headquartersIn', 'organization', { entityType: 'organization' }, 'location', { entityType: 'location' }, 'single'),
    sourceRole: 'organization', targetRole: 'location',
    labels: [
      { text: 'headquartersIn', direction: 'forward' }, { text: 'headquartered in', direction: 'forward' },
      { text: '总部位于', direction: 'forward' },
    ],
  },
  {
    spec: spec('bornOn', 'person', { entityType: 'person' }, 'date', 'date', 'single'),
    sourceRole: 'person', targetRole: 'date',
    labels: [{ text: 'bornOn', direction: 'forward' }, { text: '出生于', direction: 'forward' }, { text: 'born on', direction: 'forward' }],
  },
  {
    spec: spec('salaryAmount', 'person', { entityType: 'person' }, 'amount', 'number', 'single'),
    sourceRole: 'person', targetRole: 'amount', literalFormat: 'amount',
    labels: [{ text: 'salaryAmount', direction: 'forward' }, { text: '薪资为', direction: 'forward' }, { text: 'salary is', direction: 'forward' }],
  },
]

export function createGraphPredicateRegistry(
  registrations: readonly GraphPredicateRegistration[] = DEFAULT_GRAPH_PREDICATES,
): GraphPredicateRegistry {
  const labels = new Map<string, { registration: GraphPredicateRegistration; direction: 'forward' | 'reverse' }>()
  for (const registration of registrations) {
    if (!registration.spec.roles[registration.sourceRole] || !registration.spec.roles[registration.targetRole])
      throw new Error(`Predicate ${registration.spec.name} has missing roles`)
    for (const label of registration.labels) {
      const key = normalizeLabel(label.text)
      if (!key || labels.has(key))
        throw new Error(`Duplicate or empty predicate label: ${label.text}`)
      labels.set(key, { registration, direction: label.direction })
    }
  }
  return { registrations, lookup: label => labels.get(normalizeLabel(label)) }
}

function normalizeLabel(label: string): string { return label.normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/gu, ' ') }

export interface GraphEntityCandidate {
  entityId: string
  basis: 'explicit-id' | 'canonical-name' | 'alias' | 'context' | 'vector'
  score?: number
}

export interface GraphEntityResolution {
  runId: string
  mentionId: string
  status: 'resolved' | 'unresolved'
  entityId?: string
  basis?: 'explicit-id' | 'alias' | 'context'
  candidates: GraphEntityCandidate[]
  reason?: string
}

export type GraphTypedValue =
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number; unit?: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'date'; value: string }

export interface GraphNormalizedFact {
  runId: string
  sourceFactId: string
  status: 'ready' | 'unresolved'
  reason?: 'unknown-predicate' | 'unresolved-subject' | 'unresolved-object' | 'wrong-entity-type' | 'invalid-literal'
  predicate?: string
  predicateVersion?: number
  arguments?: Readonly<Record<string, { kind: 'entity'; entityId: string } | GraphTypedValue>>
  evidenceSpan: SourceSpan
  context: FactContext
  modelScore: number
}

export interface GraphNormalizationResult {
  runId: string
  sourceId: string
  resolutions: GraphEntityResolution[]
  facts: GraphNormalizedFact[]
  normalizedAt: number
  version: 'graph-normalization-v1'
}

export interface GraphNormalizationOptions {
  entities: readonly GraphEntityRecord[]
  aliasDecisions?: readonly GraphAliasDecision[]
  /** Trusted host identity, never a value supplied by the extraction model. */
  explicitIdentityByMentionId?: Readonly<Record<string, string>>
  /** Entities already established in the authorized conversation context. */
  contextEntityIds?: readonly string[]
  /** Similarity only proposes candidates; it never establishes identity. */
  vectorCandidatesByMentionId?: Readonly<Record<string, readonly { entityId: string; score: number }[]>>
  registry?: GraphPredicateRegistry
  scope: { ownerId: string; agentId: string; sessionId?: string }
}

export function normalizeGraphExtraction(run: GraphExtractionRun, options: GraphNormalizationOptions): GraphNormalizationResult {
  const entities = options.entities.filter(entity => sameScope(entity.scope, options.scope)
    && (entity.review === undefined || entity.review.status === 'accepted'))
  const byId = new Map(entities.map(entity => [entity.ref.id, entity]))
  const canonical = acceptedCanonicalMap(options.aliasDecisions ?? [], byId)
  const resolutions = run.entityMentions.map(mention => resolveMention(run.id, mention, options, entities, byId, canonical))
  const byMention = new Map(resolutions.map(resolution => [resolution.mentionId, resolution]))
  const mentions = new Map(run.entityMentions.map(mention => [mention.id, mention]))
  const registry = options.registry ?? createGraphPredicateRegistry()
  const facts = run.factCandidates.map(fact => normalizeFact(run.id, fact, mentions, byMention, byId, registry))
  return { runId: run.id, sourceId: run.sourceId, resolutions, facts, normalizedAt: Date.now(), version: 'graph-normalization-v1' }
}

function sameScope(a: GraphEntityRecord['scope'], b: GraphEntityRecord['scope']): boolean {
  return a.ownerId === b.ownerId && a.agentId === b.agentId
    && (a.sessionId === undefined || a.sessionId === b.sessionId)
}

function acceptedCanonicalMap(decisions: readonly GraphAliasDecision[], entities: Map<string, GraphEntityRecord>): Map<string, string> {
  const result = new Map<string, string>()
  for (const decision of [...decisions].sort((a, b) => a.transactionTime.recordedAt - b.transactionTime.recordedAt)) {
    if (decision.review.status !== 'accepted' || !entities.has(decision.canonical.id))
      continue
    for (const member of decision.members) {
      if (!entities.has(member.id))
        continue
      if (decision.action === 'split')
        result.delete(member.id)
      else
        result.set(member.id, decision.canonical.id)
    }
  }
  return result
}

function resolveMention(runId: string, mention: EntityMention, options: GraphNormalizationOptions,
  entities: readonly GraphEntityRecord[], byId: Map<string, GraphEntityRecord>, canonical: Map<string, string>): GraphEntityResolution {
  const candidates: GraphEntityCandidate[] = []
  const add = (entityId: string, basis: GraphEntityCandidate['basis'], score?: number): void => {
    const id = canonical.get(entityId) ?? entityId
    const entity = byId.get(id)
    if (entity && matchesType(mention.type, entity.entityType)
      && !candidates.some(candidate => candidate.entityId === id && candidate.basis === basis))
      candidates.push({ entityId: id, basis, ...(score === undefined ? {} : { score }) })
  }
  const explicitId = options.explicitIdentityByMentionId?.[mention.id]
  if (explicitId) {
    const id = canonical.get(explicitId) ?? explicitId
    if (byId.has(id) && matchesType(mention.type, byId.get(id)!.entityType))
      return { runId, mentionId: mention.id, status: 'resolved', entityId: id, basis: 'explicit-id', candidates: [{ entityId: id, basis: 'explicit-id' }] }
    return { runId, mentionId: mention.id, status: 'unresolved', candidates: [], reason: 'invalid-explicit-id' }
  }
  const text = normalizeName(mention.text)
  for (const entity of entities) {
    if (!matchesType(mention.type, entity.entityType))
      continue
    if (normalizeName(entity.canonicalName) === text)
      add(entity.ref.id, 'canonical-name')
    if (entity.aliases.some(alias => normalizeName(alias) === text))
      add(entity.ref.id, 'alias')
  }
  const contextIds = new Set(options.contextEntityIds ?? [])
  for (const candidate of [...candidates]) {
    if (contextIds.has(candidate.entityId))
      add(candidate.entityId, 'context')
  }
  for (const hit of options.vectorCandidatesByMentionId?.[mention.id] ?? []) {
    if (Number.isFinite(hit.score) && hit.score >= 0 && hit.score <= 1)
      add(hit.entityId, 'vector', hit.score)
  }
  const aliasIds = [...new Set(candidates.filter(candidate => candidate.basis === 'alias').map(candidate => candidate.entityId))]
  const contextIdsMatched = [...new Set(candidates.filter(candidate => candidate.basis === 'context').map(candidate => candidate.entityId))]
  const resolvedId = contextIdsMatched.length === 1 ? contextIdsMatched[0] : aliasIds.length === 1 ? aliasIds[0] : undefined
  if (resolvedId && (contextIdsMatched.length <= 1 || contextIdsMatched.includes(resolvedId)))
    return { runId, mentionId: mention.id, status: 'resolved', entityId: resolvedId,
      basis: contextIdsMatched.includes(resolvedId) ? 'context' : 'alias', candidates }
  return { runId, mentionId: mention.id, status: 'unresolved', candidates,
    reason: candidates.length ? 'insufficient-or-ambiguous-evidence' : 'no-candidate' }
}

function normalizeName(value: string): string { return value.normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/gu, ' ') }
function matchesType(mentionType: string, entityType: string): boolean {
  return normalizeName(mentionType) === normalizeName(entityType)
}

function normalizeFact(runId: string, fact: FactCandidate, mentions: Map<string, EntityMention>,
  resolutions: Map<string, GraphEntityResolution>, entities: Map<string, GraphEntityRecord>,
  registry: GraphPredicateRegistry): GraphNormalizedFact {
  const base = { runId, sourceFactId: fact.id, evidenceSpan: fact.evidenceSpan, context: fact.context, modelScore: fact.modelScore }
  const mapped = registry.lookup(fact.predicate)
  if (!mapped)
    return { ...base, status: 'unresolved', reason: 'unknown-predicate' }
  const { registration, direction } = mapped
  const sourceRole = direction === 'forward' ? registration.sourceRole : registration.targetRole
  const targetRole = direction === 'forward' ? registration.targetRole : registration.sourceRole
  const subject = resolutions.get(fact.subjectMentionId)
  if (subject?.status !== 'resolved' || !subject.entityId)
    return { ...base, status: 'unresolved', reason: 'unresolved-subject', predicate: registration.spec.name }
  const subjectType = registration.spec.roles[sourceRole]?.type
  if (!subjectType || !isEntityType(subjectType, entities.get(subject.entityId)?.entityType))
    return { ...base, status: 'unresolved', reason: 'wrong-entity-type', predicate: registration.spec.name }
  let target: { kind: 'entity'; entityId: string } | GraphTypedValue | undefined
  if ('mentionId' in fact.object) {
    if (!mentions.has(fact.object.mentionId))
      return { ...base, status: 'unresolved', reason: 'unresolved-object', predicate: registration.spec.name }
    const object = resolutions.get(fact.object.mentionId)
    if (object?.status !== 'resolved' || !object.entityId)
      return { ...base, status: 'unresolved', reason: 'unresolved-object', predicate: registration.spec.name }
    const targetType = registration.spec.roles[targetRole]?.type
    if (!targetType || !isEntityType(targetType, entities.get(object.entityId)?.entityType))
      return { ...base, status: 'unresolved', reason: 'wrong-entity-type', predicate: registration.spec.name }
    target = { kind: 'entity', entityId: object.entityId }
  }
  else {
    const targetType = registration.spec.roles[targetRole]?.type
    target = targetType ? parseLiteral(fact.object, targetType, registration.literalFormat) : undefined
    if (!target)
      return { ...base, status: 'unresolved', reason: 'invalid-literal', predicate: registration.spec.name }
  }
  return { ...base, status: 'ready', predicate: registration.spec.name,
    predicateVersion: registration.spec.ref.version,
    arguments: { [sourceRole]: { kind: 'entity', entityId: subject.entityId }, [targetRole]: target } }
}

function isEntityType(expected: GraphValueType, actual: string | undefined): boolean {
  return typeof expected === 'object' && !!actual && normalizeName(expected.entityType) === normalizeName(actual)
}

function parseLiteral(object: Extract<FactCandidate['object'], { literal: string }>, expected: GraphValueType,
  format?: 'amount'): GraphTypedValue | undefined {
  if (typeof expected === 'object')
    return undefined
  const text = object.literal.trim()
  if (expected === 'string')
    return text ? { kind: 'string', value: text } : undefined
  if (expected === 'boolean')
    return /^(true|是)$/iu.test(text) ? { kind: 'boolean', value: true }
      : /^(false|否)$/iu.test(text) ? { kind: 'boolean', value: false } : undefined
  if (expected === 'date') {
    const match = /^(\d{4})[-年](\d{1,2})[-月](\d{1,2})日?$/u.exec(text)
    if (!match)
      return undefined
    const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3])
    const date = new Date(Date.UTC(year, month - 1, day))
    return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day
      ? { kind: 'date', value: `${match[1]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` } : undefined
  }
  const numberText = text.replace(/,/gu, '')
  const amountMatch = /^(?:([¥$€])\s*)?([+-]?\d+(?:\.\d+)?)\s*(CNY|USD|EUR|元|美元|欧元)?$/iu.exec(numberText)
  if (!amountMatch)
    return undefined
  const value = Number(amountMatch[2])
  if (!Number.isFinite(value))
    return undefined
  const symbolUnit = amountMatch[1] === '¥' ? 'CNY' : amountMatch[1] === '$' ? 'USD' : amountMatch[1] === '€' ? 'EUR' : undefined
  const suffixUnit = amountMatch[3]?.toUpperCase()
  const unit = object.unit?.toUpperCase() ?? symbolUnit ?? (suffixUnit === '元' ? 'CNY'
    : suffixUnit === '美元' ? 'USD' : suffixUnit === '欧元' ? 'EUR' : suffixUnit)
  if (format === 'amount' && !unit)
    return undefined
  if (symbolUnit && unit && symbolUnit !== unit)
    return undefined
  return { kind: 'number', value, ...(unit ? { unit } : {}) }
}
