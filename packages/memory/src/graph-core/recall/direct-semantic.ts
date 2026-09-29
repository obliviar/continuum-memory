import type { MemoryEmbeddingIndex } from '../../long-term/embedding-index'
import { createDenseVectorCandidateIndex } from '../../long-term/dense-vector-candidate-index'

export const DIRECT_HYBRID_POLICY = 'direct-hybrid-rrf-v1'
/** Provisional admission threshold; not a calibrated probability of relevance. */
export const DIRECT_SEMANTIC_MIN_COSINE = 0.8
export interface DirectSemanticOptions {
  model: string
  dimensions: number
  /** Existing content-addressed cache; this route never embeds or writes facts. */
  index: Pick<MemoryEmbeddingIndex, 'get'>
  /** Trusted local-only provider. Undefined means disabled or temporarily unavailable. */
  embedQuery: (query: string) => Promise<{ model: string; vector: number[] } | undefined>
  minCosine?: number
  timeoutMs?: number
}
interface Hit { id: string; score: number }
interface SemanticResult { hits: Hit[]; scope: string[]; incomplete: boolean }

function validVector(vector: number[] | undefined, dimensions: number): vector is number[] {
  return Array.isArray(vector) && vector.length === dimensions && vector.every(Number.isFinite)
    && Math.abs(Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0)) - 1) <= 0.03
}

/** Call only with already authorized, source-verified, temporally eligible facts. */
export async function searchDirectSemantic(
  query: string,
  facts: readonly { id: string; canonicalText: string }[],
  options: DirectSemanticOptions | undefined,
  remainingMs: number,
): Promise<SemanticResult> {
  const result = (status: string, hits: Hit[] = [], incomplete = false, extra: string[] = []): SemanticResult =>
    ({ hits, incomplete, scope: [`semantic:${status}`, ...extra] })
  if (!options) return result('disabled')
  if (!facts.length) return result('no-eligible-facts')
  const started = performance.now()
  const threshold = options.minCosine ?? DIRECT_SEMANTIC_MIN_COSINE
  const maxWait = options.timeoutMs ?? 500
  if (!options.model.trim() || !Number.isSafeInteger(options.dimensions) || options.dimensions <= 0
    || !Number.isFinite(threshold) || threshold <= 0 || threshold > 1
    || !Number.isFinite(maxWait) || maxWait <= 0) return result('invalid-config', [], true)
  const scope = [`semantic-model:${options.model}`, `semantic-min-cosine:${threshold}`]
  try {
    const index = createDenseVectorCandidateIndex()
    for (const fact of facts) {
      // Model identity and exact text hash are checked by the existing cache.
      const vector = options.index.get(fact.id, options.model, fact.canonicalText)
      if (validVector(vector, options.dimensions)) index.upsert(fact.id, vector)
    }
    scope.push(`semantic-ready:${index.size()}/${facts.length}`)
    if (!index.size()) return result('empty-index', [], true, scope)
    const wait = Math.min(500, maxWait, (remainingMs - (performance.now() - started)) / 2)
    if (wait < 1) return result('budget-skipped', [], true, scope)
    let timer: ReturnType<typeof setTimeout> | undefined
    // A late embedding may finish in its local provider, but cannot publish late recall results.
    // The race also observes late rejection; always clear the timer on success/failure.
    const timeout = Symbol('timeout')
    let embedded
    try {
      embedded = await Promise.race([
        Promise.resolve().then(() => options.embedQuery(query)),
        new Promise<typeof timeout>(resolve => { timer = setTimeout(() => resolve(timeout), wait) }),
      ])
    } finally { if (timer !== undefined) clearTimeout(timer) }
    if (embedded === timeout) return result('query-timeout', [], true, scope)
    if (!embedded || embedded.model !== options.model || !validVector(embedded.vector, options.dimensions))
      return result('query-unavailable', [], true, scope)
    const hits = index.search(embedded.vector, { limit: facts.length, minScore: threshold })
    const partial = index.size() !== facts.length
    return result(partial ? 'partial' : 'ready', hits, partial, scope)
  } catch { return result('query-or-index-failed', [], true, scope) }
}

/** Fuse ranks, never treat cosine or lexical score as factual confidence. */
export function mergeDirectCandidates(lexical: readonly Hit[], semantic: readonly Hit[], structured: readonly Hit[] = []): Hit[] {
  if (!semantic.length && !structured.length) return [...lexical]
  const scores = new Map<string, number>()
  for (const channel of [lexical, semantic, structured]) {
    const seen = new Set<string>()
    channel.forEach((hit, rank) => {
      if (!seen.has(hit.id)) scores.set(hit.id, (scores.get(hit.id) ?? 0) + 1 / (60 + rank + 1))
      seen.add(hit.id)
    })
  }
  return [...scores].map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
}
