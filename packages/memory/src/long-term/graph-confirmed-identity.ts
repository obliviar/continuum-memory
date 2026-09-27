import { createHash } from 'node:crypto'
import type { GraphExtractionRun } from './graph-extraction-result'
import { createGraphPredicateRegistry, normalizeGraphExtraction,
  type GraphAliasDecision, type GraphEntityRecord, type GraphNormalizationResult,
  type GraphPredicateRegistry } from './graph-identity-normalization'

export interface ConfirmedGraphIdentityResult {
  entities: GraphEntityRecord[]
  normalized: GraphNormalizationResult
}

/** A user's fact confirmation may establish isolated IDs for unresolved mentions. It never merges names. */
export function confirmGraphFactIdentities(run: GraphExtractionRun, sourceFactId: string,
  options: { entities: readonly GraphEntityRecord[]; aliases: readonly GraphAliasDecision[];
    scope: GraphEntityRecord['scope']; registry?: GraphPredicateRegistry }): ConfirmedGraphIdentityResult {
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
  for (const item of required) {
    const resolution = original.resolutions.find(value => value.mentionId === item.id)
    if (resolution?.status === 'resolved') continue
    const mention = run.entityMentions.find(value => value.id === item.id)
    const expected = registration.spec.roles[item.role]?.type
    if (!mention || typeof expected !== 'object' || mention.type !== expected.entityType)
      throw new Error('Mention type does not match the reviewed predicate role')
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
