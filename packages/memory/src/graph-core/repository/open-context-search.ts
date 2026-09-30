import type { GraphScope, MemorySensitivity } from '@continuum-memory/contracts'
import type { GraphSemanticBundle } from '../domain/types'
import { canNavigateOpenAssertion } from './open-assertion-admission'
import { searchOpenAssertions, type OpenAssertionSearchHit } from './open-assertions'

export interface OpenContextSearchOptions {
  scope: GraphScope
  maximumDepth?: number
  limit?: number
  sensitivities?: readonly MemorySensitivity[]
  includeCandidates?: boolean
  /** Local verified model only. Omit when missing/disabled; no implicit download. */
  embed?: (text: string) => Promise<number[]>
  vectorBudget?: number
}

export interface OpenContextSearchResult {
  items: OpenAssertionSearchHit[]
  semantic: { mode: 'context-vector' | 'text-fallback'; reason?: string; compared: number; truncated: boolean }
}

/** Bounded query-time contextual ranking. Never persists sameAs or grants admission. */
export async function searchOpenAssertionsWithContext(bundle: Pick<GraphSemanticBundle, 'openAssertions'>,
  query: string, options: OpenContextSearchOptions): Promise<OpenContextSearchResult> {
  const textHits = searchOpenAssertions(bundle, query, options)
  const fallback = (reason: string): OpenContextSearchResult => ({ items: textHits,
    semantic: { mode: 'text-fallback', reason, compared: 0, truncated: false } })
  if (!query.trim()) return fallback('empty-query')
  if (!options.embed) return fallback('local-semantic-model-unavailable')
  const allowed = (bundle.openAssertions ?? []).filter(a => a.review.status !== 'rejected'
    && (canNavigateOpenAssertion(a) || options.includeCandidates)
    && a.scope.ownerId === options.scope.ownerId && a.scope.agentId === options.scope.agentId
    && (options.scope.sessionId === undefined || a.scope.sessionId === options.scope.sessionId)
    && (options.sensitivities ?? ['normal', 'private', 'secret']).includes(a.sensitivity))
  const budget = Number.isFinite(options.vectorBudget) ? Math.max(1, Math.min(64, Math.floor(options.vectorBudget!))) : 32
  const priority = new Set(textHits.map(hit => hit.assertion.ref.id))
  const candidates = [...allowed].sort((a, b) => Number(priority.has(b.ref.id)) - Number(priority.has(a.ref.id))
    || a.ref.id.localeCompare(b.ref.id)).slice(0, budget)
  try {
    const queryVector = await options.embed(query)
    const ranked: OpenAssertionSearchHit[] = []
    const vectors = new Map<string, number[]>()
    // Serial calls avoid spawning concurrent local model work for one UI request.
    for (const assertion of candidates) {
      const context = `提及：${assertion.participants.map(p => `${p.role}=${p.text}`).join('；')}\n关系：${assertion.relationText}\n原文语境：${assertion.sourceContext?.text ?? assertion.text}`
      const vector = await options.embed(context)
      const score = cosine(queryVector, vector)
      vectors.set(assertion.ref.id, vector)
      const existing = textHits.find(hit => hit.assertion.ref.id === assertion.ref.id)
      if (existing) ranked.push({ ...existing, contextSimilarity: score })
      // Exploratory relevance threshold, not calibrated correctness or auto-review.
      else if (score >= 0.6) ranked.push({ assertion, depth: 0, route: 'context-vector-candidate', contextSimilarity: score,
        verification: assertion.review.status === 'accepted' ? 'user-confirmed'
          : canNavigateOpenAssertion(assertion) ? 'automatic-navigation' : 'unverified-candidate' })
    }
    const semanticSeeds = ranked.filter(hit => hit.route === 'context-vector-candidate').sort((a, b) => (b.contextSimilarity ?? 0) - (a.contextSimilarity ?? 0)).slice(0, 5)
    const expanded = semanticSeeds.length ? searchOpenAssertions(bundle, query, { ...options,
      seedAssertionIds: semanticSeeds.map(hit => hit.assertion.ref.id) }).filter(hit => hit.depth > 0
        && !textHits.some(existing => existing.assertion.ref.id === hit.assertion.ref.id)
        && !ranked.some(existing => existing.assertion.ref.id === hit.assertion.ref.id)) : []
    const items = [...ranked.filter(hit => hit.route !== 'context-vector-candidate').sort((a, b) => a.depth - b.depth
      || (b.contextSimilarity ?? 0) - (a.contextSimilarity ?? 0)),
    ...textHits.filter(hit => !ranked.some(r => r.assertion.ref.id === hit.assertion.ref.id)),
    ...semanticSeeds, ...expanded]
    for (const hit of items) {
      if (!hit.via) continue
      const from = vectors.get(hit.via.assertionId), to = vectors.get(hit.assertion.ref.id)
      if (from && to) hit.via = { ...hit.via, contextSimilarity: cosine(from, to) }
    }
    const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(100, Math.floor(options.limit!))) : 20
    return { items: items.slice(0, limit), semantic: { mode: 'context-vector', compared: candidates.length, truncated: allowed.length > budget } }
  } catch {
    return fallback('local-semantic-model-failed')
  }
}

function cosine(a: number[], b: number[]): number {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length
    || !a.every(Number.isFinite) || !b.every(Number.isFinite)) throw new Error('Invalid context vector')
  const norm = Math.sqrt(a.reduce((sum, x) => sum + x * x, 0) * b.reduce((sum, x) => sum + x * x, 0))
  if (!Number.isFinite(norm) || norm === 0) throw new Error('Invalid context vector norm')
  return Math.max(-1, Math.min(1, a.reduce((sum, x, i) => sum + x * b[i]!, 0) / norm))
}
