import { createHash } from 'node:crypto'
import type { FactCandidate, GraphExtractionRun, SourceSpan } from './graph-extraction-result'
import { createGraphPredicateRegistry, DEFAULT_GRAPH_PREDICATES,
  type GraphPredicateRegistration, type GraphPredicateRegistry } from './graph-identity-normalization'
import { graphSourceCandidateValid } from './graph-source-integrity'

export interface BasicGraphRelation {
  scope: { ownerId: string; agentId: string; sessionId?: string }
  relationText: string
  definition: string
  registration: GraphPredicateRegistration
  originSourceId?: string
  definitionStatus?: 'observed' | 'interpreted'
}

export interface BasicGraphRelationRegistry extends GraphPredicateRegistry {
  definitions: () => BasicGraphRelation[]
  /** Returns a derived publication view. Never changes the retained extraction or raw output. */
  prepare: (run: GraphExtractionRun, options?: { ignoreMappings?: boolean }) => GraphExtractionRun
  clear: () => void
  describe: (id: string, definition: string) => void
  mappings: () => BasicGraphRelationMapping[]
  addMapping: (input: Omit<BasicGraphRelationMapping, 'id' | 'active'>) => boolean
  revokeMapping: (id: string) => void
}

export interface BasicGraphRelationMapping {
  id: string
  sourceId: string
  targetId: string
  roleMapping: Record<string, string>
  kind: 'equivalent' | 'inverse'
  evidenceSourceId: string
  model: string
  active: boolean
}

/** Basic registration records a source expression and observed role types, not general inference rules. */
export function createBasicGraphRelationRegistry(persistence: {
  load: () => string | undefined
  save: (payload: string) => void
}, scope: BasicGraphRelation['scope']): BasicGraphRelationRegistry {
  const payload = persistence.load()
  const stored = payload ? JSON.parse(payload) as { version: number; definitions: BasicGraphRelation[]; mappings?: BasicGraphRelationMapping[] } : undefined
  if (stored && (stored.version !== 1 || !Array.isArray(stored.definitions)))
    throw new Error('Invalid basic relation registry')
  let definitions = stored?.definitions ?? []
  let mappings = stored?.mappings ?? []
  if (definitions.some(item => JSON.stringify(item.scope) !== JSON.stringify(scope)
    || item.registration.spec.registrationKind !== 'basic'
    || item.registration.spec.inferenceAllowed || item.registration.spec.transitivity !== 'none'
    || item.registration.spec.symmetry !== 'none')) throw new Error('Invalid basic relation definition')
  let registry = createGraphPredicateRegistry([...DEFAULT_GRAPH_PREDICATES, ...definitions.map(item => item.registration)])
  const register = (run: GraphExtractionRun, fact: FactCandidate, ignoreMappings = false): FactCandidate | undefined => {
    if (fact.mappingId && (ignoreMappings || !mappings.some(m => m.id === fact.mappingId && m.active))) {
      const { roleMapping: _roles, mappingId: _mapping, registrationKind: _kind, ...original } = fact
      fact = { ...original, predicate: fact.relationText ?? fact.predicate }
    }
    if (registry.lookup(fact.predicate)) return fact
    if (!graphSourceCandidateValid(run, fact)) return undefined
    const span = fact.relationSpan ?? literalRelationSpan(run.sourceText, fact)
    if (!span || run.sourceText.slice(span.start, span.end) !== fact.predicate
      || span.start < fact.evidenceSpan.start || span.end > fact.evidenceSpan.end) return undefined
    const participants = fact.participants ?? [{ mentionId: fact.subjectMentionId, role: 'subject' },
      ...('mentionId' in fact.object ? [{ mentionId: fact.object.mentionId, role: 'object' }] : [])]
    if (!participants.length || participants.some(p => !clearRole(p.role))) return undefined
    if (new Set(participants.map(p => p.role)).size !== participants.length) return undefined
    if (!run.supplementalEvidence?.length && participants.some(p => ambiguousMention(run.entityMentions.find(m => m.id === p.mentionId)?.text ?? ''))) return undefined
    if (participants.some(p => {
      const mention = run.entityMentions.find(m => m.id === p.mentionId)!
      return span.start < mention.span.end && mention.span.start < span.end
    })) return undefined
    const roles: Record<string, GraphPredicateRegistration['spec']['roles'][string]> = Object.fromEntries(participants.map(p => {
      const mention = run.entityMentions.find(m => m.id === p.mentionId)!
      return [p.role, { type: { entityType: mention.type }, required: true }]
    }))
    const sourceRole = participants[0]!.role
    const targetRole = participants[1]?.role ?? ('literal' in fact.object ? 'value' : sourceRole)
    if ('literal' in fact.object) roles[targetRole] = { type: fact.object.valueType === 'amount'
      ? 'number' : fact.object.valueType ?? 'string', required: true }
    if (!roles[targetRole]) return undefined
    const keyParts = [scope.ownerId, scope.agentId, scope.sessionId ?? null,
      fact.predicate.normalize('NFKC').trim(), roles, sourceRole, targetRole]
    if (run.relationSenses?.[fact.id]) keyParts.push('sense', run.relationSenses[fact.id]!)
    const key = JSON.stringify(keyParts)
    const name = `source-relation:${createHash('sha256').update(key).digest('hex').slice(0, 32)}`
    if (!definitions.some(item => item.registration.spec.name === name)) {
      const registration: GraphPredicateRegistration = {
        spec: { ref: { kind: 'predicate', id: name, version: 1 }, name, roles,
          cardinality: 'multiple', keyRoles: [sourceRole], valueRole: sourceRole === targetRole ? null : targetRole,
          symmetry: 'none', transitivity: 'none', inferenceAllowed: false, world: 'open',
          registrationKind: 'basic', relationText: fact.predicate },
        sourceRole, targetRole, labels: [{ text: name, direction: 'forward' }],
      }
      const definition: BasicGraphRelation = { scope: structuredClone(scope), relationText: fact.predicate,
        originSourceId: run.sourceId,
        definitionStatus: 'observed',
        definition: `原文关系“${fact.predicate}”；参与角色：${Object.keys(roles).join('、')}。类型仅表示本次观察，不赋予推理规则。`,
        registration }
      const next = [...definitions, definition]
      const nextRegistry = createGraphPredicateRegistry([...DEFAULT_GRAPH_PREDICATES, ...next.map(item => item.registration)])
      persistence.save(JSON.stringify({ version: 1, definitions: next, mappings }))
      definitions = next
      registry = nextRegistry
    }
    const mapping = !ignoreMappings ? mappings.find(item => item.active && item.sourceId === name) : undefined
    return { ...fact, predicate: mapping?.targetId ?? name, relationText: fact.predicate, relationSpan: span,
      participants, registrationKind: 'basic', ...(mapping ? { roleMapping: mapping.roleMapping, mappingId: mapping.id } : {}) }
  }
  return {
    get registrations() { return registry.registrations },
    lookup: label => registry.lookup(label),
    definitions: () => structuredClone(definitions),
    mappings: () => structuredClone(mappings),
    describe(id, definition) {
      if (!definition.trim() || definition.length > 1000) return
      const next = definitions.map(d => d.registration.spec.name === id
        && (d.definitionStatus === 'observed' || (!d.definitionStatus && d.definition.startsWith('原文关系')))
        ? { ...d, definition: definition.trim(), definitionStatus: 'interpreted' as const } : d)
      persistence.save(JSON.stringify({ version: 1, definitions: next, mappings })); definitions = next
    },
    addMapping(input) {
      const source = registry.registrations.find(r => r.spec.name === input.sourceId)
      const target = registry.registrations.find(r => r.spec.name === input.targetId)
      if (!source || !target || source.spec.registrationKind !== 'basic' || source.spec.name === target.spec.name
        || !['equivalent', 'inverse'].includes(input.kind)) return false
      if (mappings.some(m => !m.active && m.sourceId === input.sourceId && m.targetId === input.targetId)) return false
      const sourceRoles = Object.keys(source.spec.roles), targetRoles = Object.keys(target.spec.roles)
      if (Object.keys(input.roleMapping).length !== sourceRoles.length || sourceRoles.length !== targetRoles.length
        || new Set(Object.values(input.roleMapping)).size !== targetRoles.length
        || !sourceRoles.every(role => targetRoles.includes(input.roleMapping[role]!)
          && (target.spec.registrationKind === 'basic'
            ? observedTypesCompatible(source.spec.roles[role]!.type, target.spec.roles[input.roleMapping[role]!]!.type)
            : JSON.stringify(source.spec.roles[role]!.type) === JSON.stringify(target.spec.roles[input.roleMapping[role]!]!.type)))) return false
      // Mappings are direct and acyclic; do not silently compose different role transforms.
      if (mappings.some(m => m.active && (m.sourceId === input.targetId || m.targetId === input.sourceId))) return false
      const id = `relation-mapping:${createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 32)}`
      const next = [...mappings.filter(m => m.sourceId !== input.sourceId), { ...structuredClone(input), id, active: true }]
      persistence.save(JSON.stringify({ version: 1, definitions, mappings: next })); mappings = next
      return true
    },
    revokeMapping(id) {
      const next = mappings.map(m => m.id === id ? { ...m, active: false } : m)
      persistence.save(JSON.stringify({ version: 1, definitions, mappings: next })); mappings = next
    },
    clear() {
      persistence.save(JSON.stringify({ version: 1, definitions: [], mappings: [] }))
      definitions = []
      mappings = []
      registry = createGraphPredicateRegistry()
    },
    prepare(input, options) {
      if (input.status !== 'complete') return input
      const run = structuredClone(input)
      const facts = run.factCandidates.map(source => {
        const fact = structuredClone(source)
        return register(run, fact, options?.ignoreMappings) ?? fact
      })
      const existing = new Set(facts.map(fact => fact.id))
      for (const assertion of run.assertionCandidates ?? []) {
        if (!assertion.relationSpan || assertion.participants.length < 1
          || existing.has(assertion.id) || assertion.participants.some(p => !clearRole(p.role))
          || new Set(assertion.participants.map(p => p.role)).size !== assertion.participants.length) continue
        // Primary roles are storage anchors only; every participant remains in the Claim.
        // Stable role order prevents a different model output order from creating duplicate definitions.
        const participants = structuredClone(assertion.participants).sort((a, b) =>
          roleOrder(a.role) - roleOrder(b.role) || a.role.localeCompare(b.role))
        const [subject, second] = participants
        const object = second ?? subject
        const candidate: FactCandidate = { id: assertion.id, subjectMentionId: subject!.mentionId,
          predicate: assertion.relationText, object: { mentionId: object!.mentionId },
          evidenceSpan: { ...assertion.evidenceSpan }, modelScore: assertion.modelScore, context: structuredClone(assertion.context),
          relationSpan: { ...assertion.relationSpan }, participants, sourceAssertionId: assertion.id }
        const view = { ...run, factCandidates: [candidate] }
        const mapped = register(view, candidate, options?.ignoreMappings)
        // Existing normalized predicates keep their established binary role semantics.
        if (mapped && (mapped.registrationKind === 'basic' || assertion.participants.length === 2)) {
          facts.push(mapped)
          existing.add(candidate.id)
        }
      }
      return { ...run, factCandidates: facts }
    },
  }
}

function clearRole(role: string): boolean {
  return !!role.trim() && role === role.trim() && role.length <= 80 && !/^(unknown|未知|不明|participant|参与者)$/iu.test(role)
    && !['__proto__', 'constructor', 'prototype'].includes(role)
}

function roleOrder(role: string): number {
  if (/^(subject|agent|actor|source|主体|施事)$/iu.test(role)) return 0
  if (/^(object|patient|target|对象|受事)$/iu.test(role)) return 1
  return 2
}

function observedTypesCompatible(a: GraphPredicateRegistration['spec']['roles'][string]['type'],
  b: GraphPredicateRegistration['spec']['roles'][string]['type']): boolean {
  if (typeof a !== 'object' || typeof b !== 'object') return a === b
  const categories: Record<string, string> = { person: 'person', 人物: 'person', 人: 'person',
    organization: 'organization', 组织: 'organization', 公司: 'organization', location: 'location', 地点: 'location',
    project: 'project', 项目: 'project', course: 'course', 课程: 'course', film: 'film', book: 'book', song: 'song' }
  const left = categories[a.entityType], right = categories[b.entityType]
  return left || right ? left === right : true
}

function ambiguousMention(text: string): boolean {
  return !text || /^(他|她|它|他们|她们|它们|这|那|这里|那里|对方|其|这个|那个|这个项目|那个项目|这台设备|那台设备)$/u.test(text.trim())
}

function literalRelationSpan(text: string, fact: FactCandidate): SourceSpan | undefined {
  const evidence = text.slice(fact.evidenceSpan.start, fact.evidenceSpan.end)
  const at = evidence.indexOf(fact.predicate)
  if (at < 0 || evidence.indexOf(fact.predicate, at + 1) >= 0) return undefined
  return { start: fact.evidenceSpan.start + at, end: fact.evidenceSpan.start + at + fact.predicate.length }
}
