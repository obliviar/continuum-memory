import { independentEvidenceSelection } from './evidence-selection-text'

export interface RecallCandidate { id: string; score: number }
export interface ScoredEvidenceCandidate extends RecallCandidate {
  text: string
  /** Exact authorized answer-slot key. Similarity must never supply this key. */
  evidenceGroup?: string
}
/** Trusted local relevance assessment. Decisions are not factual truth/probability judgments. */
export interface GraphEvidenceSelector {
  readonly id: string
  select: (input: { query: string; candidates: readonly ScoredEvidenceCandidate[]; signal: AbortSignal }) => Promise<{
    status: 'accepted' | 'insufficient' | 'ambiguous'
    ids: readonly string[]
  }>
}
/** Trusted local scorer; it may reorder authorized candidates, never introduce a new ID or assert truth. */
export interface GraphCandidateReranker {
  readonly id: string
  rank: (input: { query: string; candidates: readonly ScoredEvidenceCandidate[]; signal: AbortSignal }) => Promise<readonly RecallCandidate[]>
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
  /** Only a host-validated equivalent wording; query still governs literal focus. */
  relevanceQuery?: string
  /** An exact literal value from the authorized fact, never inferred from its prose. */
  literal?: (id: string) => unknown
  group?: (id: string) => string | undefined
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
        const deadline = performance.now() + timeoutMs
        const scores = await Promise.race([
          Promise.resolve().then(() => scorer.rank({ query: input.relevanceQuery ?? input.query,
            candidates: candidates.map(hit => ({ ...hit, text: input.text(hit.id), evidenceGroup: input.group?.(hit.id) })), signal: controller.signal })),
          new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')) }, timeoutMs) }),
        ])
        if (controller.signal.aborted || performance.now() >= deadline) throw new Error('timeout')
        const allowed = new Set(candidates.map(hit => hit.id))
        if (!Array.isArray(scores) || scores.length !== candidates.length || new Set(scores.map(hit => hit.id)).size !== allowed.size
          || scores.some(hit => !allowed.has(hit.id) || !Number.isFinite(hit.score))) throw new Error('invalid-output')
        ranked = scores.map(hit => ({ id: hit.id, score: hit.score })).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
        reranker = `applied:${scorer.id}`
      } catch { controller.abort(); reranker = 'failed-or-timeout-original-order' }
      finally { controller.abort(); if (timer !== undefined) clearTimeout(timer) }
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
        const deadline = performance.now() + wait
        const decision = await Promise.race([
          Promise.resolve().then(() => selector.select({ query: input.relevanceQuery ?? input.query,
            candidates: candidates.map(hit => ({ ...hit, text: input.text(hit.id), evidenceGroup: input.group?.(hit.id) })), signal: controller.signal })),
          new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')) }, wait) }),
        ])
        if (controller.signal.aborted || performance.now() >= deadline) throw new Error('timeout')
        const allowed = new Set(candidates.map(hit => hit.id))
        if (!decision || !['accepted', 'insufficient', 'ambiguous'].includes(decision.status) || !Array.isArray(decision.ids)
          || new Set(decision.ids).size !== decision.ids.length || decision.ids.some(id => !allowed.has(id))
          || (decision.status === 'accepted' ? decision.ids.length === 0 : decision.ids.length > 0)) throw new Error('invalid-output')
        const accepted = new Set(decision.ids)
        admitted = ranked.filter(hit => accepted.has(hit.id))
        assessment = `${decision.status}:${selector.id}`
      } catch { controller.abort(); assessment = 'failed-or-timeout-abstain' }
      finally { controller.abort(); if (timer !== undefined) clearTimeout(timer) }
    }
  }
  // A focused verification question about an explicit stored value must not be
  // answered using another merely related value. Open/compound questions remain broad.
  const normalize = (s: string) => s.normalize('NFKC').trim().toLowerCase()
  const query = normalize(input.query)
  const broad = independentEvidenceSelection(query) || /哪里|哪儿|为何|为什么|如何|怎么|多少|还是|\b(?:where|why|how|or)\b/i.test(query)
  const literals = candidates.flatMap(hit => {
    const raw = input.literal?.(hit.id)
    if (typeof raw !== 'string') return []
    const value = normalize(raw)
    if (value.length < 2 || value.length > 120) return []
    return [{ id: hit.id, value }]
  })
  const mentioned = !broad ? literals.filter(({ value }) => {
    for (let at = query.indexOf(value); at >= 0; at = query.indexOf(value, at + 1)) {
      if (/^[a-z0-9_]/.test(value) && /[a-z0-9_]/.test(query[at - 1] ?? '')) continue
      if (/[a-z0-9_]$/.test(value) && /[a-z0-9_]/.test(query[at + value.length] ?? '')) continue
      return true
    }
    return false
  }) : []
  const focus = new Set(mentioned.map(row => row.id))
  if (focus.size) admitted = admitted.filter(hit => focus.has(hit.id))
  return { candidates, selected: admitted.slice(0, input.finalLimit),
    assessmentIncomplete: assessment !== 'not-configured' && (admitted.length < candidates.length || assessment === 'budget-skipped'),
    truncated: unique.length > limit || admitted.length > input.finalLimit,
    scope: [`candidate-pool:${candidates.length}`, `candidate-limit:${limit}`, `selection-limit:${input.finalLimit}`, `reranker:${reranker}`,
      `evidence-assessment:${assessment}`, `evidence-admitted:${admitted.length}`, `evidence-withheld:${candidates.length - admitted.length}`,
      ...(focus.size ? [`evidence-literal-focus:${focus.size}`] : []),
      ...(unique.length > limit ? ['candidate-pool-truncated'] : []),
      ...(admitted.length > input.finalLimit ? ['candidate-selection-truncated'] : [])] }
}
