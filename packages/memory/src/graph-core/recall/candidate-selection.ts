export interface RecallCandidate { id: string; score: number }
/** Trusted local relevance assessment. Decisions are not factual truth/probability judgments. */
export interface GraphEvidenceSelector {
  readonly id: string
  select: (input: { query: string; candidates: readonly (RecallCandidate & { text: string })[]; signal: AbortSignal }) => Promise<{
    status: 'accepted' | 'insufficient' | 'ambiguous'
    ids: readonly string[]
  }>
}
/** Trusted local scorer; it may reorder authorized candidates, never introduce a new ID or assert truth. */
export interface GraphCandidateReranker {
  readonly id: string
  rank: (input: { query: string; candidates: readonly (RecallCandidate & { text: string })[]; signal: AbortSignal }) => Promise<readonly RecallCandidate[]>
}
export interface CandidateSelectionOptions {
  candidateLimit?: number
  timeoutMs?: number
  reranker?: GraphCandidateReranker
  evidenceSelector?: GraphEvidenceSelector
}
export function candidateLimit(options?: CandidateSelectionOptions): number {
  const limit = options?.candidateLimit ?? 64
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new Error('Candidate limit must be an integer in [1,256]')
  return limit
}

/** Unchanged ranking when no scorer is configured; retrieval and output limits are independent. */
export async function selectRecallCandidates(input: {
  query: string; hits: readonly RecallCandidate[]; text: (id: string) => string
  finalLimit: number; remainingMs: number; options?: CandidateSelectionOptions
  /** Conservative admission using original retrieval scores, independent of reranking scores. */
  admissibleIds?: ReadonlySet<string>
}) {
  const started = performance.now()
  const limit = candidateLimit(input.options)
  if (!Number.isSafeInteger(input.finalLimit) || input.finalLimit < 0) throw new Error('Invalid final candidate limit')
  const seen = new Set<string>()
  const unique = input.hits.filter(hit => {
    if (!hit.id || !Number.isFinite(hit.score)) throw new Error('Invalid retrieval candidate')
    if (seen.has(hit.id)) return false
    seen.add(hit.id); return true
  })
  const candidates = unique.slice(0, limit).map(hit => ({ ...hit }))
  let ranked = candidates
  let reranker = 'disabled'
  const scorer = input.options?.reranker
  if (scorer && candidates.length && input.finalLimit > 0) {
    const timeoutMs = Math.min(input.options?.timeoutMs ?? 300, Math.max(0, input.remainingMs / 2))
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1) reranker = 'budget-skipped'
    else {
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const scores = await Promise.race([
          Promise.resolve().then(() => scorer.rank({ query: input.query,
            candidates: candidates.map(hit => ({ ...hit, text: input.text(hit.id) })), signal: controller.signal })),
          new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')) }, timeoutMs) }),
        ])
        const allowed = new Set(candidates.map(hit => hit.id))
        if (!Array.isArray(scores) || scores.length !== candidates.length || new Set(scores.map(hit => hit.id)).size !== allowed.size
          || scores.some(hit => !allowed.has(hit.id) || !Number.isFinite(hit.score))) throw new Error('invalid-output')
        ranked = scores.map(hit => ({ id: hit.id, score: hit.score })).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
        reranker = `applied:${scorer.id}`
      } catch { controller.abort(); reranker = 'failed-or-timeout-original-order' }
      finally { if (timer !== undefined) clearTimeout(timer) }
    }
  }
  let admitted = input.admissibleIds ? ranked.filter(hit => input.admissibleIds!.has(hit.id)) : ranked
  let assessment = input.admissibleIds ? 'conservative-retrieval-gate' : 'not-configured'
  const selector = input.options?.evidenceSelector
  if (selector && candidates.length && input.finalLimit > 0) {
    // A failed assessor must not silently bypass an explicit relevance decision.
    admitted = []
    const wait = Math.min(input.options?.timeoutMs ?? 300, Math.max(0, (input.remainingMs - (performance.now() - started)) / 2))
    assessment = 'budget-skipped'
    if (Number.isFinite(wait) && wait >= 1) {
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const decision = await Promise.race([
          Promise.resolve().then(() => selector.select({ query: input.query,
            candidates: candidates.map(hit => ({ ...hit, text: input.text(hit.id) })), signal: controller.signal })),
          new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')) }, wait) }),
        ])
        const allowed = new Set(candidates.map(hit => hit.id))
        if (!decision || !['accepted', 'insufficient', 'ambiguous'].includes(decision.status) || !Array.isArray(decision.ids)
          || new Set(decision.ids).size !== decision.ids.length || decision.ids.some(id => !allowed.has(id))
          || (decision.status === 'accepted' ? decision.ids.length === 0 : decision.ids.length > 0)) throw new Error('invalid-output')
        const accepted = new Set(decision.ids)
        admitted = ranked.filter(hit => accepted.has(hit.id))
        assessment = `${decision.status}:${selector.id}`
      } catch { controller.abort(); assessment = 'failed-or-timeout-abstain' }
      finally { if (timer !== undefined) clearTimeout(timer) }
    }
  }
  return { candidates, selected: admitted.slice(0, input.finalLimit),
    assessmentIncomplete: assessment !== 'not-configured' && (admitted.length < candidates.length || assessment === 'budget-skipped'),
    truncated: unique.length > limit || admitted.length > input.finalLimit,
    scope: [`candidate-pool:${candidates.length}`, `candidate-limit:${limit}`, `selection-limit:${input.finalLimit}`, `reranker:${reranker}`,
      `evidence-assessment:${assessment}`, `evidence-admitted:${admitted.length}`, `evidence-withheld:${candidates.length - admitted.length}`,
      ...(unique.length > limit ? ['candidate-pool-truncated'] : []),
      ...(admitted.length > input.finalLimit ? ['candidate-selection-truncated'] : [])] }
}
