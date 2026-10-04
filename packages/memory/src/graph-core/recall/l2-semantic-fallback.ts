import { DIRECT_SEMANTIC_MIN_COSINE, type DirectSemanticOptions, type SemanticResult } from './direct-semantic'

/** Experimental, trusted-host configuration. No production defaults or probability interpretation. */
export interface L2SemanticFallbackOptions {
  /** Pin calibration to the exact embedding model fingerprint. */
  model: string
  minCosine: number
  minMargin: number
}

export function validL2SemanticFallback(policy: L2SemanticFallbackOptions, semantic: DirectSemanticOptions | undefined): boolean {
  const normal = semantic?.minCosine ?? DIRECT_SEMANTIC_MIN_COSINE
  return !!semantic && typeof policy.model === 'string' && !!policy.model.trim() && policy.model === semantic.model
    && Number.isFinite(normal) && normal > 0 && normal <= 1
    && Number.isFinite(policy.minCosine) && policy.minCosine > 0 && policy.minCosine < normal
    && Number.isFinite(policy.minMargin) && policy.minMargin > 0 && policy.minMargin <= 2
}

/** Only used when normal target ranking is empty. Never promote a second-best fact after filtering. */
export function selectL2SemanticFallback(result: SemanticResult, policy: L2SemanticFallbackOptions): { hits: SemanticResult['hits']; scope: string[] } {
  const scope = ['l2-semantic-fallback-margin-v1', `semantic-fallback-min-cosine:${policy.minCosine}`,
    `semantic-fallback-min-margin:${policy.minMargin}`]
  const finish = (status: string, hits: SemanticResult['hits'] = []) =>
    ({ hits, scope: [...scope, `semantic-fallback:${status}`] })
  if (result.incomplete || !result.scope.includes('semantic:ready')) return finish('unavailable-or-incomplete')
  const [first, second] = result.competition
  // A singleton cache is not evidence that a candidate has no close competitors.
  if (!first || !second || first.id === second.id) return finish('insufficient-competition')
  if (!Number.isFinite(first.score) || !Number.isFinite(second.score)
    || first.score < -1 || first.score > 1 || second.score < -1 || second.score > first.score)
    return finish('invalid-scores')
  scope.push(`semantic-fallback-best:${first.score}`, `semantic-fallback-gap:${first.score - second.score}`)
  if (first.score < policy.minCosine) return finish('below-floor')
  if (first.score - second.score < policy.minMargin) return finish('ambiguous')
  return finish('candidate', [first])
}
