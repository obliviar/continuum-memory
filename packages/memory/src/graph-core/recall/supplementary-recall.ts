import { candidateLimit, selectRecallCandidates, type RecallCandidate } from './candidate-selection'
import { recallQueryVariants } from './query-expansion'

export interface SupplementaryCandidatePool {
  hits: readonly RecallCandidate[]
  admissibleIds?: ReadonlySet<string>
  scope: string[]
}

/** At most one additional pass, sharing the caller's deadline and final output budget. */
export async function selectWithSupplementaryRecall(input: Parameters<typeof selectRecallCandidates>[0] & {
  enabled?: boolean
  protectedQueryTerms?: readonly string[]
  searchScope: readonly string[]
  searchAgain: (candidateLimit: number, signal: AbortSignal) => Promise<SupplementaryCandidatePool>
}) {
  const started = performance.now()
  const first = await selectRecallCandidates(input)
  if (!input.enabled) return first
  const tag = (reason: string) => ({ ...first, scope: [...first.scope, `supplementary-recall:${reason}`] })
  if (input.finalLimit === 0) return tag('output-budget-zero')
  if (first.scope.some(s => /failed-or-timeout|budget-skipped/.test(s))) return tag('assessment-unavailable')
  const hidden = first.scope.includes('candidate-pool-truncated') || input.searchScope.includes('entity-top-k-truncated')
    || input.searchScope.includes('seed-top-k-truncated')
  if (first.selected.length && (!hidden || first.selected.length >= input.finalLimit)) return tag('not-needed')
  const normalized = recallQueryVariants(input.query, input.protectedQueryTerms).at(-1)!
  const canRescore = normalized !== input.query && !!input.options?.evidenceSelector
  if (!hidden && !canRescore) return tag('no-additional-route')
  const remaining = () => input.remainingMs - (performance.now() - started)
  if (remaining() < 100) return tag('budget-skipped')
  const base = candidateLimit(input.options), expanded = Math.max(base, Math.min(64, base * 2))
  if (expanded === base && !input.searchScope.includes('entity-top-k-truncated') && !canRescore)
    return tag('candidate-ceiling')
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const pool = hidden ? await Promise.race([input.searchAgain(expanded, controller.signal),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('budget')) }, Math.max(1, remaining() - 100)) })])
      : { hits: input.hits, admissibleIds: input.admissibleIds, scope: ['supplementary-search:reuse-validated-candidates'] }
    if (timer !== undefined) { clearTimeout(timer); timer = undefined }
    if (remaining() < 100) return tag('budget-skipped')
    // Never publish a result assessed after its deadline. Original evidence remains checked
    // by the adapter's final source/version validation even when the extra pass fails.
    const second = await selectRecallCandidates({ ...input, hits: pool.hits, admissibleIds: pool.admissibleIds,
      relevanceQuery: canRescore ? normalized : input.query, remainingMs: remaining(),
      options: { ...input.options, candidateLimit: expanded } })
    if (second.scope.some(s => /failed-or-timeout|budget-skipped/.test(s))) return tag('failed-kept-first-pass')
    if (first.selected.some(hit => !second.selected.some(other => other.id === hit.id))) return tag('changed-evidence-kept-first-pass')
    return { ...second, scope: [...second.scope, ...pool.scope, 'supplementary-recall:completed-once',
      `supplementary-first-selected:${first.selected.length}`, `supplementary-candidate-limit:${expanded}`,
      ...(canRescore ? ['supplementary-scoring:conservative-equivalent-query'] : [])] }
  } catch { return tag('failed-kept-first-pass') }
  finally { controller.abort(); if (timer !== undefined) clearTimeout(timer) }
}
