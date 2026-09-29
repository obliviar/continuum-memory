import type { GraphScope } from '@continuum-memory/contracts'
import { createDirectLexicalIndex } from './direct-lexical'
import { mergeDirectCandidates } from './direct-semantic'

export const L2_SEED_POLICY = 'l2-target-first-rrf-v1'
export interface L2SeedDocument {
  /** Exact Claim key; multiple Claims may refer to the same fact. */
  id: string
  factId: string
  text: string
  predicate: string
  entityNames: readonly string[]
}
const normalize = (text: string) => text.normalize('NFKC').trim().replace(/[。.!！?？]+$/u, '')
  .trim().replace(/\s+/g, ' ').toLowerCase()

/** Authorized/time-filtered candidates only. Ranking does not resolve identity or assert relations. */
export function rankL2Seeds(query: string, scope: GraphScope, documents: readonly L2SeedDocument[],
  dense: readonly { id: string; score: number }[], limit: number) {
  const target = normalize(query), index = createDirectLexicalIndex(query)
  const byFact = new Map<string, L2SeedDocument[]>()
  for (const d of documents) {
    index.upsert({ id: d.id, scope, state: 'active', content: `${d.text} ${d.predicate} ${d.entityNames.join(' ')}` })
    const versions = byFact.get(d.factId) ?? []
    versions.push(d); byFact.set(d.factId, versions)
  }
  const lexical = index.search(query, { scope, limit: documents.length, minScore: 0.2 })
  const exact = documents.filter(d => normalize(d.text) === target).map(d => ({ id: d.id, score: 1 }))
    .sort((a, b) => a.id.localeCompare(b.id))
  const names = documents.filter(d => d.entityNames.some(name => normalize(name) === target))
    .map(d => ({ id: d.id, score: 1 })).sort((a, b) => a.id.localeCompare(b.id))
  const semantic = dense.flatMap(hit => (byFact.get(hit.id) ?? []).map(d => ({ id: d.id, score: hit.score })))
  // Equal text does not merge identities. All exact versions remain candidates within the same budget.
  const selectedPool = exact.length ? exact : names.length ? names : undefined
  const ranked = selectedPool ?? mergeDirectCandidates(lexical, semantic, names)
  const items = ranked.slice(0, limit).map((hit, i) => ({ id: hit.id, relevance: 1 / (i + 1),
    route: selectedPool ? 'structured' as const : lexical.some(h => h.id === hit.id) ? 'lexical' as const : 'dense' as const }))
  return { items, scope: [L2_SEED_POLICY, `seed-selection:${exact.length ? 'exact-claim' : names.length ? 'exact-entity-name' : 'hybrid'}`,
    `seed-matches:${ranked.length}`, `seed-selected:${items.length}`,
    ...(ranked.length > limit ? ['seed-top-k-truncated'] : []),
    ...[...new Set(items.map(item => item.route))].map(route => `seed-route:${route}`)] }
}
