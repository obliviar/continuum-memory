import { createHash } from 'node:crypto'
import type { GraphExtractionRun } from './graph-extraction-result'
import { createGraphPredicateRegistry, normalizeGraphExtraction,
  type GraphAliasDecision, type GraphEntityRecord, type GraphNormalizationResult,
  type GraphPredicateRegistry } from './graph-identity-normalization'

export interface ConfirmedGraphIdentityResult {
  entities: GraphEntityRecord[]
  normalized: GraphNormalizationResult
}

/** A reviewed mention chooses an exact existing ID or a source-isolated new ID; names never merge by themselves. */
export function confirmGraphFactIdentities(run: GraphExtractionRun, sourceFactId: string,
  options: { entities: readonly GraphEntityRecord[]; aliases: readonly GraphAliasDecision[];
    scope: GraphEntityRecord['scope']; registry?: GraphPredicateRegistry;
    choicesByMentionId?: Readonly<Record<string, string>> }): ConfirmedGraphIdentityResult {
  const source = run.factCandidates.find(item => item.id === sourceFactId)
  if (!source) throw new Error('Graph fact source is unavailable')
  const registry = options.registry ?? createGraphPredicateRegistry()
  const lookup = registry.lookup(source.predicate)
  if (!lookup) throw new Error('Unknown predicate requires registry review')
  const { registration, direction } = lookup
  const subjectRole = direction === 'forward' ? registration.sourceRole : registration.targetRole
  const objectRole = direction === 'forward' ? registration.targetRole : registration.sourceRole
  const required = [{ id: source.subjectMentionId, role: subjectRole }]
  if ('mentionId' in source.object) required.push({ id: source.object.mentionId, role: objectRole })
  const catalog = [...options.entities]
  const original = normalizeGraphExtraction(run, { entities: catalog, aliasDecisions: options.aliases,
    scope: options.scope, registry })
  const explicitIdentityByMentionId: Record<string, string> = {}
  if (options.choicesByMentionId && Object.keys(options.choicesByMentionId).some(id => !required.some(item => item.id === id)))
    throw new Error('Identity decision contains a mention outside this fact')
  for (const item of required) {
    const resolution = original.resolutions.find(value => value.mentionId === item.id)
    const choice = options.choicesByMentionId?.[item.id]
    if (resolution?.status === 'resolved' && choice === undefined) continue
    const mention = run.entityMentions.find(value => value.id === item.id)
    const expected = registration.spec.roles[item.role]?.type
    if (!mention || typeof expected !== 'object' || mention.type !== expected.entityType)
      throw new Error('Mention type does not match the reviewed predicate role')
    if (options.choicesByMentionId && !choice)
      throw new Error('Each unresolved mention needs an explicit identity decision')
    if (choice && choice !== 'new') {
      const target = catalog.find(entity => entity.ref.id === choice && entity.entityType === mention.type
        && entity.review?.status !== 'rejected' && entity.scope.ownerId === options.scope.ownerId
        && entity.scope.agentId === options.scope.agentId && entity.scope.sessionId === options.scope.sessionId)
      if (!target) throw new Error('Selected identity is absent, unreviewed, or outside the current scope')
      explicitIdentityByMentionId[mention.id] = target.ref.id
      continue
    }
    const id = `confirmed-entity:${createHash('sha256').update(`${run.sourceId}\0${run.sourceRevision}\0${mention.id}`).digest('hex').slice(0, 32)}`
    if (!catalog.some(entity => entity.ref.id === id)) {
      catalog.push({ ref: { kind: 'entity', id, version: 1 }, scope: options.scope,
        entityType: mention.type, canonicalName: mention.text, aliases: [], review: { status: 'accepted' } })
    }
    explicitIdentityByMentionId[mention.id] = id
  }
  const normalized = normalizeGraphExtraction(run, { entities: catalog, aliasDecisions: options.aliases,
    scope: options.scope, registry, explicitIdentityByMentionId })
  if (normalized.facts.find(item => item.sourceFactId === sourceFactId)?.status !== 'ready')
    throw new Error('Fact still needs predicate, type, or literal review')
  return { entities: catalog, normalized }
}
