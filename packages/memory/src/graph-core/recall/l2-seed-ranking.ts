import type { GraphScope } from '@continuum-memory/contracts'
import { createDirectLexicalIndex, directLexicalTerms } from './direct-lexical'
import { mergeDirectCandidates } from './direct-semantic'
import { readL2TargetState, targetStateCompatible } from './l2-target-state'
import { planL2EntityTarget, type L2EntityBinding } from './l2-entity-target'

export const L2_SEED_POLICY = 'l2-entity-target-rrf-v4'
export interface L2SeedDocument {
  /** Exact Claim key; multiple Claims may refer to the same fact. */
  id: string
  factId: string
  text: string
  predicate: string
  entityNames: readonly string[]
  entityBindings?: readonly L2EntityBinding[]
}
const normalize = (text: string) => text.normalize('NFKC').trim().replace(/[。.!！?？]+$/u, '')
  .trim().replace(/\s+/g, ' ').toLowerCase()

/** Authorized/time-filtered candidates only. Ranking does not resolve identity or assert relations. */
export function rankL2Seeds(query: string, scope: GraphScope, documents: readonly L2SeedDocument[],
  dense: readonly { id: string; score: number }[], limit: number,
  entityCatalog: readonly L2EntityBinding[] = documents.flatMap(d => d.entityBindings ?? [])) {
  const target = normalize(query), index = createDirectLexicalIndex(query)
  const queryState = readL2TargetState(query)
  const states = new Map(documents.map(d => [d.id, readL2TargetState(d.text)]))
  const entityTarget = planL2EntityTarget(query, entityCatalog)
  const bindings = new Map(documents.map(d => [d.id, d.entityBindings ?? []]))
  const entityMatches = (id: string) => entityTarget.matches(bindings.get(id)!)
  const byFact = new Map<string, L2SeedDocument[]>()
  const termsByClaim = new Map<string, Set<string>>()
  const vocabulary = new Set<string>()
  for (const d of documents) {
    index.upsert({ id: d.id, scope, state: 'active', content: `${d.text} ${d.predicate} ${d.entityNames.join(' ')}` })
    const versions = byFact.get(d.factId) ?? []
    versions.push(d); byFact.set(d.factId, versions)
    // Predicate identifiers can be implementation labels, not evidence of a matching event.
    const terms = new Set(directLexicalTerms(query, [states.get(d.id)!.content, ...d.entityNames].join(' ')))
    termsByClaim.set(d.id, terms); terms.forEach(term => vocabulary.add(term))
  }
  const lexical = index.search(query, { scope, limit: documents.length, minScore: 0.2 })
  const exact = documents.filter(d => normalize(d.text) === target).map(d => ({ id: d.id, score: 1 }))
    .sort((a, b) => a.id.localeCompare(b.id))
  const names = documents.filter(d => d.entityNames.some(name => normalize(name) === target))
    .map(d => ({ id: d.id, score: 1 })).sort((a, b) => a.id.localeCompare(b.id))
  const semantic = dense.flatMap(hit => (byFact.get(hit.id) ?? []).map(d => ({ id: d.id, score: hit.score })))
  // Query terms known in this authorized corpus must co-occur in one candidate. Never join
  // different events just because their pooled words happen to cover the target query.
  // Unknown paraphrase terms are not invented constraints; dense-only retrieval remains possible.
  const queryTerms = [...new Set(directLexicalTerms(query, queryState.content))]
  const anchors = queryTerms.filter(term => vocabulary.has(term))
  const coversTarget = (id: string) => anchors.every(term => termsByClaim.get(id)?.has(term))
  // Equal text does not merge identities. All exact versions remain candidates within the same budget.
  const selectedPool = exact.length ? exact : names.length ? names : undefined
  const merged = mergeDirectCandidates(lexical, semantic, names)
  const pool = selectedPool ?? merged
  const stateMatches = (id: string) => exact.length > 0 || targetStateCompatible(queryState, states.get(id)!)
  const denseIds = new Set(semantic.map(hit => hit.id))
  // Generic failure/inability words alone cannot identify an event. A learned dense candidate may
  // supply a paraphrase route, but it still has to pass state and known content-anchor checks.
  const contentMatches = (id: string) => !!selectedPool || !queryState.outcome || (queryTerms.length > 0
    && (denseIds.has(id) || queryTerms.some(term => termsByClaim.get(id)?.has(term))))
  const rejected = selectedPool ? 0 : pool.filter(hit => !coversTarget(hit.id)).length
  const stateRejected = pool.filter(hit => !stateMatches(hit.id)).length
  const contentRejected = pool.filter(hit => !contentMatches(hit.id)).length
  const entityRejected = pool.filter(hit => !entityMatches(hit.id)).length
  const ranked = pool.filter(hit => entityMatches(hit.id) && stateMatches(hit.id) && contentMatches(hit.id)
    && (!!selectedPool || coversTarget(hit.id)))
  const items = ranked.slice(0, limit).map((hit, i) => ({ id: hit.id, relevance: 1 / (i + 1),
    route: selectedPool ? 'structured' as const : lexical.some(h => h.id === hit.id) ? 'lexical' as const : 'dense' as const }))
  return { items, scope: [L2_SEED_POLICY, `seed-selection:${exact.length ? 'exact-claim' : names.length ? 'exact-entity-name' : 'hybrid'}`,
    `seed-matches:${ranked.length}`, `seed-selected:${items.length}`,
    `seed-query-anchors:${anchors.length}`, `seed-anchor-rejected:${rejected}`,
    `seed-state-rejected:${stateRejected}`, `seed-content-rejected:${contentRejected}`,
    ...entityTarget.scope, `seed-entity-rejected:${entityRejected}`,
    ...(queryState.ambiguous ? ['seed-target-state:ambiguous'] : []),
    ...(!ranked.length ? [
      ...(rejected ? ['seed-abstention:target-anchors-unresolved'] : []),
      ...(stateRejected ? ['seed-abstention:target-state-unresolved'] : []),
      ...(contentRejected ? ['seed-abstention:no-content-match'] : []),
      ...(entityRejected ? ['seed-abstention:entity-target-unresolved'] : []),
      ...(!pool.length ? ['seed-abstention:no-matching-candidate'] : []),
    ] : []),
    ...(ranked.length > limit ? ['seed-top-k-truncated'] : []),
    ...[...new Set(items.map(item => item.route))].map(route => `seed-route:${route}`)] }
}
