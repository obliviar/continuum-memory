import { createHash } from 'node:crypto'
import type { GraphExtractionRun } from './graph-extraction-result'
import { graphSourceCandidateValid } from './graph-source-integrity'
import { createGraphPredicateRegistry, normalizeGraphExtraction,
  type GraphAliasDecision, type GraphEntityRecord, type GraphNormalizationResult,
  type GraphPredicateRegistry } from './graph-identity-normalization'

/** Bind an explicit self reference, otherwise keep source-local identities. Never merge by name. */
export function autoNormalizeUieGraphFact(run: GraphExtractionRun, sourceFactId: string, options: {
  entities: readonly GraphEntityRecord[]
  aliases: readonly GraphAliasDecision[]
  scope: GraphEntityRecord['scope']
  registry?: GraphPredicateRegistry
}): { entities: GraphEntityRecord[]; normalized: GraphNormalizationResult } | undefined {
  const fact = run.factCandidates.find(item => item.id === sourceFactId)
  if (!fact || !graphSourceCandidateValid(run, fact)) return undefined
  const registry = options.registry ?? createGraphPredicateRegistry()
  const mapping = registry.lookup(fact.predicate)
  if (!mapping) return undefined
  const sourceRole = mapping.direction === 'forward' ? mapping.registration.sourceRole : mapping.registration.targetRole
  const targetRole = mapping.direction === 'forward' ? mapping.registration.targetRole : mapping.registration.sourceRole
  const required = [{ id: fact.subjectMentionId, role: sourceRole },
    ...('mentionId' in fact.object ? [{ id: fact.object.mentionId, role: targetRole }] : [])]
  const entities = [...options.entities]
  const baseline = normalizeGraphExtraction(run, { entities, aliasDecisions: options.aliases, scope: options.scope, registry })
  const explicitIdentityByMentionId: Record<string, string> = {}
  for (const item of required) {
    const mention = run.entityMentions.find(value => value.id === item.id)
    const expected = mapping.registration.spec.roles[item.role]?.type
    if (!mention || typeof expected !== 'object' || mention.type !== expected.entityType) return undefined
    const resolution = baseline.resolutions.find(value => value.mentionId === item.id)
    const self = mention.type === 'person' && mention.text === '我'
      && fact.context.speaker.resolution === 'resolved' && fact.context.speaker.value === 'user'
      && !/[“”"「」『』‘’']/u.test(run.sourceText.slice(fact.evidenceSpan.start, fact.evidenceSpan.end))
    const key = self ? `${options.scope.ownerId}\0${options.scope.agentId}\0${options.scope.sessionId ?? ''}\0self`
      : `${options.scope.ownerId}\0${options.scope.agentId}\0${options.scope.sessionId ?? ''}\0${run.sourceId}\0${run.sourceRevision}\0${mention.id}`
    const id = self ? `owner-entity:${createHash('sha256').update(key).digest('hex').slice(0, 32)}`
      : resolution?.status === 'resolved' && resolution.entityId ? resolution.entityId : `source-entity:${createHash('sha256')
      .update(key)
      .digest('hex').slice(0, 32)}`
    if (!entities.some(entity => entity.ref.id === id)) entities.push({
      ref: { kind: 'entity', id, version: 1 }, scope: options.scope,
      entityType: mention.type, canonicalName: mention.text, aliases: [], review: { status: 'accepted' },
    })
    explicitIdentityByMentionId[mention.id] = id
  }
  const normalized = normalizeGraphExtraction(run, { entities, aliasDecisions: options.aliases,
    scope: options.scope, registry, explicitIdentityByMentionId })
  return normalized.facts.find(item => item.sourceFactId === sourceFactId)?.status === 'ready'
    ? { entities, normalized } : undefined
}
