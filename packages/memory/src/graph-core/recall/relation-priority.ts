import type { GraphClaimRef, GraphFactRef, GraphRelationRef } from '@continuum-memory/contracts'
import type { GraphRecallRelationKind } from '../domain/recall-types'
import { searchDirectSemantic, type DirectSemanticOptions } from './direct-semantic'

export interface RelationPriorityCandidate {
  readonly ref: GraphRelationRef
  readonly kind: GraphRecallRelationKind
  /** Exact, authorized, source-hydrated endpoints, in stored relation direction. */
  readonly from: { readonly ref: GraphClaimRef; readonly fact: GraphFactRef; readonly text: string }
  readonly to: { readonly ref: GraphClaimRef; readonly fact: GraphFactRef; readonly text: string }
}
export interface GraphRelationRanker {
  readonly id: string
  /** Local relevance only. Must score every input reference exactly once. */
  rank: (input: { query: string; candidates: readonly RelationPriorityCandidate[]; remainingMs: number; signal: AbortSignal }) =>
    Promise<readonly { ref: GraphRelationRef; score: number }[]>
}
export interface RelationPriorityOptions {
  /** Per-node neighbor page, not a global graph or whole-depth candidate pool. */
  windowSize?: number
  timeoutMs?: number
  ranker: GraphRelationRanker
}
export interface RelationPriorityDecision {
  status: 'applied' | 'single-candidate' | 'budget-skipped' | 'fallback-original-order'
  refs: GraphRelationRef[]
  elapsedMs: number
}
const key = (ref: GraphRelationRef) => JSON.stringify([ref.kind, ref.id, ref.version])

export function relationPriorityWindow(options: RelationPriorityOptions): number {
  const size = options.windowSize ?? 4
  if (!Number.isSafeInteger(size) || size < 1 || size > 16
    || !Number.isFinite(options.timeoutMs ?? 200) || (options.timeoutMs ?? 200) <= 0
    || !options.ranker.id.trim()) throw new Error('Invalid relation priority configuration')
  return size
}

/** Reorder a fully checked window without pruning, adding IDs, or touching authoritative cursors. */
export async function orderRelationWindow(input: {
  query: string; candidates: readonly RelationPriorityCandidate[]; remainingMs: number; options: RelationPriorityOptions
}): Promise<RelationPriorityDecision> {
  const started = performance.now()
  const original = input.candidates.map(c => c.ref)
  const result = (status: RelationPriorityDecision['status'], refs = original): RelationPriorityDecision =>
    ({ status, refs, elapsedMs: performance.now() - started })
  if (original.length <= 1) return result('single-candidate')
  const wait = Math.min(200, input.options.timeoutMs ?? 200, input.remainingMs / 2)
  if (!Number.isFinite(wait) || wait < 1) return result('budget-skipped')
  const allowed = new Map(original.map((ref, index) => [key(ref), index]))
  if (allowed.size !== original.length) return result('fallback-original-order')
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const scores = await Promise.race([
      Promise.resolve().then(() => input.options.ranker.rank({ query: input.query,
        candidates: structuredClone(input.candidates), remainingMs: wait, signal: controller.signal })),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')) }, wait) }),
    ])
    // A synchronous provider can block the timer; elapsed time still disqualifies late results.
    if (performance.now() - started >= wait) return result('fallback-original-order')
    if (!Array.isArray(scores) || scores.length !== original.length || new Set(scores.map(s => key(s.ref))).size !== original.length
      || scores.some(s => !allowed.has(key(s.ref)) || !Number.isFinite(s.score))) return result('fallback-original-order')
    // Equal scores keep the authoritative page order. Return original references only.
    const sorted = [...scores].sort((a, b) => b.score - a.score || allowed.get(key(a.ref))! - allowed.get(key(b.ref))!)
    return result('applied', sorted.map(s => original[allowed.get(key(s.ref))!]!))
  } catch { return result('fallback-original-order') }
  finally { controller.abort(); if (timer !== undefined) clearTimeout(timer) }
}

/** Create once per recall. Cached endpoint vectors only; no new relation embeddings or remote API. */
export function createEndpointVectorRelationRanker(options: DirectSemanticOptions): GraphRelationRanker {
  // The full question may differ from the seed query. Share its embedding across this recall's windows only.
  let cached: { query: string; value: ReturnType<DirectSemanticOptions['embedQuery']> } | undefined
  const embedQuery: DirectSemanticOptions['embedQuery'] = query => {
    if (!cached || cached.query !== query) cached = { query, value: Promise.resolve().then(() => options.embedQuery(query)) }
    return cached.value
  }
  return { id: 'endpoint-vector-mean-v1', async rank(input) {
    if (input.signal.aborted) throw new Error('aborted')
    const facts = new Map<string, { id: string; canonicalText: string; version: number }>()
    for (const candidate of input.candidates) for (const endpoint of [candidate.from, candidate.to]) {
      const previous = facts.get(endpoint.fact.id)
      if (previous && (previous.version !== endpoint.fact.version || previous.canonicalText !== endpoint.text))
        throw new Error('Conflicting endpoint fact versions')
      facts.set(endpoint.fact.id, { id: endpoint.fact.id, canonicalText: endpoint.text, version: endpoint.fact.version })
    }
    const ranked = await searchDirectSemantic(input.query, [...facts.values()],
      { ...options, embedQuery, rankOnly: true }, input.remainingMs)
    // Partial vectors must not systematically put unembedded alternatives last.
    if (input.signal.aborted || ranked.incomplete || ranked.hits.length !== facts.size) throw new Error('Endpoint vectors unavailable')
    const scores = new Map(ranked.hits.map(hit => [hit.id, hit.score]))
    return input.candidates.map(c => ({ ref: c.ref, score: (scores.get(c.from.fact.id)! + scores.get(c.to.fact.id)!) / 2 }))
  } }
}
