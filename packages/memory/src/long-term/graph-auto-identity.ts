import { createHash } from 'node:crypto'
import type { GraphExtractionRun } from './graph-extraction-result'
import { createGraphPredicateRegistry, normalizeGraphExtraction,
  type GraphAliasDecision, type GraphEntityRecord, type GraphNormalizationResult,
  type GraphPredicateRegistry } from './graph-identity-normalization'

/** Establish only source-local identities for a grounded UIE fact. Never merge by name. */
export function autoNormalizeUieGraphFact(run: GraphExtractionRun, sourceFactId: string, options: {
  entities: readonly GraphEntityRecord[]
  aliases: readonly GraphAliasDecision[]
  scope: GraphEntityRecord['scope']
  registry?: GraphPredicateRegistry
}): { entities: GraphEntityRecord[]; normalized: GraphNormalizationResult } | undefined {
  const fact = run.factCandidates.find(item => item.id === sourceFactId)
  if (run.modelId !== 'uie-base' || run.status !== 'complete' || !fact
    || fact.modelScore < (fact.subjectMentionId.startsWith('uie-personal:') ? 0.7 : 0.8)
    || fact.context.negation.resolution !== 'resolved'
    || fact.context.negation.value !== false || fact.context.condition.resolution !== 'absent'
    || fact.context.speaker.resolution !== 'resolved') return undefined
  const registry = options.registry ?? createGraphPredicateRegistry()
  const mapping = registry.lookup(fact.predicate)
  if (!mapping) return undefined
  const sourceRole = mapping.direction === 'forward' ? mapping.registration.sourceRole : mapping.registration.targetRole
  const targetRole = mapping.direction === 'forward' ? mapping.registration.targetRole : mapping.registration.sourceRole
  const required = [{ id: fact.subjectMentionId, role: sourceRole },
    ...('mentionId' in fact.object ? [{ id: fact.object.mentionId, role: targetRole }] : [])]
  const entities = [...options.entities]
  const explicitIdentityByMentionId: Record<string, string> = {}
  for (const item of required) {
    const mention = run.entityMentions.find(value => value.id === item.id)
    const expected = mapping.registration.spec.roles[item.role]?.type
    if (!mention || typeof expected !== 'object' || mention.type !== expected.entityType) return undefined
    const id = `source-entity:${createHash('sha256')
      .update(`${options.scope.ownerId}\0${options.scope.agentId}\0${run.sourceId}\0${run.sourceRevision}\0${mention.id}`)
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
