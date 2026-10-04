import { RECALL_RELATION_KINDS } from '../domain/recall-types'
import type { GraphEntityRef, GraphResult, GraphTemporalQuery } from '@continuum-memory/contracts'
import type { GraphRecallRelationKind as GraphRelationKind } from '../domain/recall-types'
import { hasUnresolvedGraphTime, planGraphQueryTime } from './query-time-plan'
import type { GraphQueryTimeOptions, GraphQueryTimePlan } from './query-time-plan'
import { graphCalendarDates } from './calendar-dates'

export type GraphQuestionType = 'cause' | 'effect' | 'before' | 'after' | 'related'
  | 'explanation' | 'explained' | 'premise' | 'implication' | 'conflict'
export interface GraphQueryConstraints {
  /** Exact identities resolved by the trusted host, never guessed from names. All must match the seed. */
  readonly entities?: readonly GraphEntityRef[]
  /** Host-resolved target event wording; used for retrieval rather than inventing an event ID. */
  readonly targetText?: string
  readonly questionType?: GraphQuestionType
}
export interface GraphQueryPlanInput {
  readonly query: string
  readonly relationModel?: 'l2'
  readonly temporal: GraphTemporalQuery
  readonly timePlanning?: GraphQueryTimeOptions
  readonly constraints?: GraphQueryConstraints
  readonly direction?: 'in' | 'out' | 'both'
  readonly kinds?: readonly GraphRelationKind[]
}
export interface GraphQueryPlan {
  readonly version: 'graph-query-plan/v1'
  readonly originalQuery: string
  readonly questionType: GraphQuestionType | 'custom' | 'unresolved'
  readonly status: 'ready' | 'needs-clarification'
  readonly clarificationReasons: readonly ('question-type' | 'competing-intents' | 'multiple-targets' | 'target-event' | 'unresolved-pronoun')[]
  readonly target: {
    readonly text: string
    readonly resolution: 'candidate-needed'
    readonly entities: readonly GraphEntityRef[]
    readonly entityResolution: 'host-resolved' | 'not-resolved'
  }
  readonly searchQuery: string
  readonly temporal: GraphTemporalQuery
  readonly timePlan: GraphQueryTimePlan | null
  readonly traversal: {
    readonly direction: 'in' | 'out' | 'both'
    readonly kinds: readonly GraphRelationKind[]
    readonly source: 'question' | 'caller'
  } | null
  /** The missing semantic slot, not a claim that matching evidence has been found. */
  readonly missingInformation: 'cause' | 'effect' | 'earlier-event' | 'later-event' | 'related-claim' | 'unresolved'
    | 'explanation-basis' | 'explained-claim' | 'entailment-premise' | 'entailed-claim' | 'conflicting-claim'
  readonly requiredEvidence: readonly ['target-claim', 'linked-claim', 'relation-record', 'source-spans']
  readonly followUpChecks: readonly ['competing-explanations', 'conflicts']
}

type QueryRoute = { direction: 'in' | 'out' | 'both'; kinds: GraphRelationKind[] }
const ROUTES: Partial<Record<GraphQuestionType, QueryRoute>> = {
  cause: { direction: 'in', kinds: ['causal', 'contributes-to'] },
  effect: { direction: 'out', kinds: ['causal', 'contributes-to'] },
  before: { direction: 'in', kinds: ['before'] },
  after: { direction: 'out', kinds: ['before'] },
  related: { direction: 'both', kinds: ['causal', 'contributes-to', 'before'] },
}
const L2_ROUTES: Record<GraphQuestionType, QueryRoute> = {
  cause: { direction: 'in', kinds: ['causes'] }, effect: { direction: 'out', kinds: ['causes'] },
  before: { direction: 'in', kinds: ['precedes'] }, after: { direction: 'out', kinds: ['precedes'] },
  related: { direction: 'both', kinds: ['causes', 'precedes', 'explains', 'entails', 'contradicts'] },
  explanation: { direction: 'in', kinds: ['explains'] }, explained: { direction: 'out', kinds: ['explains'] },
  premise: { direction: 'in', kinds: ['entails'] }, implication: { direction: 'out', kinds: ['entails'] },
  conflict: { direction: 'both', kinds: ['contradicts'] },
}
const CUES: Partial<Record<GraphQuestionType, RegExp>> = {
  cause: /为什么|为何|原因|什么(?:导致|造成|引起)|\bwhy\b|\breason\b/i,
  effect: /(?:导致|造成|引起|带来|产生)了?(?:什么|哪些)|(?:有什么|有哪些|有何)(?:影响|后果)|\b(?:effects?|consequences?)\b/i,
  before: /(?:之前|以前)(?:发生|有)|\bwhat\s+happened\s+before\b/i,
  after: /(?:之后|以后)(?:发生|有)|\bwhat\s+happened\s+after\b/i,
  related: /相关|关联|\brelated\b/i,
  explanation: /(?:解释依据|解释根据|依据)(?:是什么|有哪些)|^(?:是什么|什么|哪些(?:事实|命题|记录|信息)?)(?:能|可以)?解释/i,
  explained: /解释(?:了)?(?:什么|哪些)/i,
  premise: /^(?:什么|哪些(?:事实|命题|记录)?)(?:能|可以)?蕴含|蕴含前提(?:是什么|有哪些)/i,
  implication: /蕴含(?:什么|哪些)/i,
  conflict: /(?:与|和)(?:什么|哪些)(?:事实|命题|记录|说法)?(?:相)?(?:矛盾|冲突)/i,
}

// Anchored forms with an explicit target slot. Bare "explain" or "support" is not a relation type.
const TARGET_FORMS: Partial<Record<GraphQuestionType, readonly RegExp[]>> = {
  explanation: [/^(?:是什么|什么|哪些(?:事实|命题|记录|信息)?)(?:能|可以)?解释(?:了)?(.+?)[?？]*$/i,
    /^(.+?)(?:的)?(?:解释依据|解释根据|依据)(?:是什么|有哪些)[?？]*$/i,
    /^what\s+(?:explains|is\s+the\s+explanation\s+for)\s+(.+?)[?？]*$/i],
  explained: [/^(.+?)(?:能|可以)?解释(?:了)?(?:什么|哪些)(?:事实|命题|现象|事情)?[?？]*$/i,
    /^what\s+(?:does|did|can)\s+(.+?)\s+explain[?？]*$/i],
  premise: [/^(?:什么|哪些(?:事实|命题|记录)?)(?:能|可以)?蕴含(.+?)[?？]*$/i,
    /^(.+?)的蕴含前提(?:是什么|有哪些)[?？]*$/i,
    /^what\s+entails\s+(.+?)[?？]*$/i],
  implication: [/^(.+?)(?:能|可以)?蕴含(?:什么|哪些)(?:事实|命题|结论)?[?？]*$/i,
    /^what\s+(?:does|did|can)\s+(.+?)\s+entail[?？]*$/i],
  conflict: [/^(.+?)(?:与|和)(?:什么|哪些)(?:事实|命题|记录|说法)?(?:相)?(?:矛盾|冲突)[?？]*$/i,
    /^(?:什么|哪些)(?:事实|命题|记录|说法)?(?:与|和)(.+?)(?:相)?(?:矛盾|冲突)[?？]*$/i,
    /^what\s+(?:contradicts|conflicts\s+with)\s+(.+?)[?？]*$/i],
}
const normalizeQuestion = (query: string) => query.normalize('NFKC').trim()
  .replace(/^(?:请问|想问一下|我想问一下)[，,\s]*/, '').replace(/呢[?？]*$/, '').replace(/[?？。!！]+$/, '').trim()
function explicitTarget(text: string, type: GraphQuestionType): string | undefined {
  for (const pattern of TARGET_FORMS[type] ?? []) {
    const match = pattern.exec(text)
    if (match) return match[1]?.trim()
  }
  return undefined
}
function inferredIntents(text: string): GraphQuestionType[] {
  const clauses = [text, ...questionClauses(text)]
  return (Object.keys(L2_ROUTES) as GraphQuestionType[]).filter(type => clauses.some(clause =>
    CUES[type]?.test(clause) || explicitTarget(clause, type) !== undefined))
}
function questionClauses(text: string): string[] {
  return text.split(/[,，;；]|以及|并且|同时|和(?=(?:什么|哪些|为什么))|\s+and\s+/i).map(s => s.trim()).filter(Boolean)
}

/** Shared host routing guard: unresolved relationship questions must not fall through to direct facts. */
export function hasGraphRelationIntent(query: string): boolean {
  const text = normalizeQuestion(query)
  return inferredIntents(text).length > 0
    // 以前/以后 alone can qualify a direct fact (e.g. 以前住在哪里).
    // Event-order questions using them are recognized by the before/after cues above.
    || /为什么|为何|原因|导致|先后|之前|之后|哪个(?:事件)?在[先后]|谁先|谁后|\b(?:why|caus\w*|before|after|effects?|consequences?|related)\b/i.test(text)
    || /^(?:解释(?:一下|下)?|请解释)|(?:什么|哪些|是否|哪里).*(?:蕴含|矛盾|冲突)|(?:解释|蕴含|矛盾|冲突).*(?:什么|哪些|吗)$|\bwhat\b.*\b(?:explain\w*|entail\w*|contradict\w*|conflicts?|basis|support)\b|^explain\b/i.test(text)
}

/** Finite, inspectable query grammar. It does not perform entity resolution or prove causality. */
export function planGraphQuery(input: GraphQueryPlanInput): GraphResult<GraphQueryPlan> {
  const bad = (message: string): GraphResult<GraphQueryPlan> => ({ ok: false, error: { code: 'invalid-request', message } })
  const query = input.query.normalize('NFKC').trim()
  const hints = input.constraints ?? {}
  const entities = hints.entities ?? []
  if (!query || query.length > 2000
    || (hints.targetText !== undefined && (!hints.targetText.trim() || hints.targetText.length > 2000))
    || (hints.questionType !== undefined && !Object.hasOwn(L2_ROUTES, hints.questionType))
    || (input.direction !== undefined && !['in', 'out', 'both'].includes(input.direction))
    || (input.kinds !== undefined && (input.kinds.length === 0 || input.kinds.some(kind => !RECALL_RELATION_KINDS.includes(kind))))
    || entities.some(ref => ref.kind !== 'entity' || !ref.id.trim() || !Number.isSafeInteger(ref.version) || ref.version < 1))
    return bad('Invalid graph query, constraints or traversal options')
  if (input.relationModel === 'l2' && input.kinds?.some(kind => !['causes', 'precedes', 'explains', 'entails', 'contradicts'].includes(kind)))
    return bad('Canonical L2 relations required; legacy relation names are not implicitly mapped')
  const t = input.temporal
  if (!Number.isSafeInteger(t.knownAt) || !(t.valid.kind === 'at' ? Number.isSafeInteger(t.valid.at)
    : t.valid.kind === 'overlap' && Number.isSafeInteger(t.valid.from) && Number.isSafeInteger(t.valid.to) && t.valid.from < t.valid.to))
    return bad('Invalid graph temporal constraint')
  let timePlan: GraphQueryTimePlan | null = null
  if (input.timePlanning) {
    const planned = planGraphQueryTime(query, t, input.timePlanning)
    if (!planned.ok) return planned
    timePlan = planned.value
  }
  else {
    if (hasUnresolvedGraphTime(query)) return bad('Relative time must be resolved with an explicit reference time')
    try {
      if (graphCalendarDates(query).length > 1) return bad('Date ranges require explicit time planning')
    }
    catch { return bad('Invalid calendar date in query') }
  }
  const text = normalizeQuestion(timePlan?.lexicalQuery ?? query)
  const inferred = inferredIntents(text)
  const explicitRoute = input.direction !== undefined && input.kinds !== undefined
  const intent = hints.questionType ?? (inferred.length === 1 ? inferred[0] : undefined)
  const reasons: Array<GraphQueryPlan['clarificationReasons'][number]> = []
  if (!hints.questionType && !explicitRoute) {
    if (inferred.length > 1) reasons.push('competing-intents')
    else if (!intent) reasons.push('question-type')
  }
  if (hints.targetText === undefined && questionClauses(text).filter(clause => inferredIntents(clause).length > 0).length > 1)
    reasons.push('multiple-targets')
  const base = intent ? (input.relationModel === 'l2' ? L2_ROUTES : ROUTES)[intent] : undefined
  if (intent && !base && !explicitRoute) reasons.push('question-type')
  const route = base || explicitRoute ? {
    direction: input.direction ?? base!.direction,
    kinds: [...new Set(input.kinds ?? base!.kinds)],
    source: input.direction !== undefined || input.kinds !== undefined || hints.questionType !== undefined ? 'caller' as const : 'question' as const,
  } : null
  const targetText = cleanTarget(hints.targetText ?? targetFromQuestion(text, intent))
  if (!targetText || /^(?:谁|什么|为什么|为何|who|what|why)[?\s]*$/i.test(targetText)) reasons.push('target-event')
  // Named text remains lexical until a host resolves it. Pronouns need explicit identity.
  if (entities.length === 0 && (/^(?:他|她|它)(?:们)?/.test(targetText) || /\b(?:he|she|they|him|her|them)\b/i.test(targetText)
    || /^(?:这|那)(?:个|件|条|种)?(?:事|事件|情况|结论|说法|事实|命题|记录|结果|现象|一点)$/.test(targetText)
    || /^(?:this|that|it|these|those)(?:\s+(?:event|claim|statement|conclusion|result)s?)?$/i.test(targetText)))
    reasons.push('unresolved-pronoun')
  const custom = explicitRoute || (route?.source === 'caller' && (input.direction !== undefined || input.kinds !== undefined))
  const type = custom ? 'custom' : intent ?? 'unresolved'
  const missing: GraphQueryPlan['missingInformation'] = type === 'before' ? 'earlier-event' : type === 'after' ? 'later-event'
    : type === 'explanation' ? 'explanation-basis' : type === 'explained' ? 'explained-claim'
      : type === 'premise' ? 'entailment-premise' : type === 'implication' ? 'entailed-claim'
        : type === 'conflict' ? 'conflicting-claim'
    : type === 'cause' || type === 'effect' ? type : type === 'unresolved' ? 'unresolved' : 'related-claim'
  return { ok: true, value: structuredClone({
    version: 'graph-query-plan/v1', originalQuery: input.query, questionType: type,
    status: reasons.length === 0 && route !== null ? 'ready' : 'needs-clarification', clarificationReasons: reasons,
    target: { text: targetText, resolution: 'candidate-needed',
      entities: [...new Map(entities.map(ref => [JSON.stringify([ref.id, ref.version]), ref])).values()],
      entityResolution: entities.length ? 'host-resolved' : 'not-resolved' },
    searchQuery: targetText, temporal: timePlan?.temporal ?? t, timePlan,
    traversal: reasons.length ? null : route, missingInformation: missing,
    requiredEvidence: ['target-claim', 'linked-claim', 'relation-record', 'source-spans'],
    followUpChecks: ['competing-explanations', 'conflicts'],
  }) }
}

function targetFromQuestion(text: string, intent: GraphQuestionType | undefined): string {
  if (intent && TARGET_FORMS[intent]) return explicitTarget(text, intent) ?? ''
  if (intent === 'cause') return text.replace(/为什么|为何|\bwhy\b/gi, ' ')
    .replace(/^(?:是什么|什么)(?:导致|造成|引起)了?/, '')
    .replace(/(?:是)?什么原因[?]*$/, '')
    .replace(/的?原因(?:是什么|有哪些)?[?]*$/, '')
  if (intent === 'effect') return text
    .replace(/(?:导致|造成|引起|带来|产生)了?(?:什么|哪些)(?:影响|后果|变化)?[?]*$/, '')
    .replace(/(?:有什么|有哪些|有何)(?:影响|后果)[?]*$/, '')
    .replace(/^what\s+(?:are|were)\s+the\s+(?:effects?|consequences?)\s+of\s+/i, '')
  if (intent === 'before' || intent === 'after') return text
    .replace(/(?:之前|以前|之后|以后)(?:发生了什么|发生过什么|发生什么|有什么|有哪些)(?:事|事件|事情)?[?]*$/, '')
    .replace(/^what\s+happened\s+(?:before|after)\s+/i, '')
  if (intent === 'related') return text.replace(/(?:与|和)?(.+?)(?:有何|有什么|有哪些)?(?:相关|关联)(?:的)?(?:记忆|事件|事情)?[?]*$/, '$1')
  return text
}
function cleanTarget(text: string): string { return text.replace(/[?？。!！]+$/g, '').replace(/\s+/g, ' ').trim() }
