import { createHash } from 'node:crypto'
import type { GraphCandidateReranker, GraphEvidenceSelector, RecallCandidate } from './candidate-selection'
import { independentEvidenceSelection } from './evidence-selection-text'

export interface LocalCrossEncoder {
  readonly id: string
  score: (query: string, candidates: readonly { id: string; text: string }[], signal: AbortSignal) => Promise<readonly RecallCandidate[]>
}

/** Local pair relevance, not NLI and not a calibrated answer probability. */
export function createCrossEncoderSelection(model: LocalCrossEncoder, options: { minLogit: number; maxLogitGap?: number }) {
  if (!Number.isFinite(options.minLogit)) throw new Error('An explicit finite experimental logit cutoff is required')
  if (options.maxLogitGap !== undefined && (!Number.isFinite(options.maxLogitGap) || options.maxLogitGap < 0))
    throw new Error('Invalid relative relevance band')
  let cached: { key: string; scores: readonly RecallCandidate[] } | undefined
  const score = async (input: { query: string; candidates: readonly { id: string; text: string }[]; signal: AbortSignal }) => {
    input.signal.throwIfAborted()
    const key = createHash('sha256').update(JSON.stringify([model.id, input.query, input.candidates.map(c => [c.id, c.text])])).digest('hex')
    if (cached?.key === key) return cached.scores
    cached = undefined
    const result = await model.score(input.query, input.candidates, input.signal)
    input.signal.throwIfAborted()
    const allowed = new Set(input.candidates.map(c => c.id))
    if (!Array.isArray(result) || result.length !== allowed.size || new Set(result.map(c => c.id)).size !== allowed.size
      || result.some(c => !allowed.has(c.id) || !Number.isFinite(c.score))) throw new Error('Invalid cross-encoder scores')
    const scores = result.map(c => ({ id: c.id, score: c.score }))
    cached = { key, scores }
    return scores
  }
  const reranker: GraphCandidateReranker = { id: model.id, rank: score }
  const evidenceSelector: GraphEvidenceSelector = { id: `${model.id}:slot-selection-v2:logit-cutoff=${options.minLogit}${options.maxLogitGap === undefined ? '' : `:gap=${options.maxLogitGap}`}`, select: async input => {
    const scores = await score(input)
    // An open question may retain weaker independently relevant values in the same exact
    // answer slot. Other slots still need the relative band; this is not a probability.
    const multiple = independentEvidenceSelection(input.query)
    const floor = Math.max(options.minLogit, options.maxLogitGap === undefined ? -Infinity
      : Math.max(...scores.map(c => c.score)) - options.maxLogitGap)
    const groups = new Map(input.candidates.map(c => [c.id, c.evidenceGroup]))
    const strongGroups = new Set(scores.filter(c => c.score >= floor).flatMap(c => groups.get(c.id) ? [groups.get(c.id)!] : []))
    const ids = scores.filter(c => c.score >= options.minLogit && (c.score >= floor
      || (multiple && !!groups.get(c.id) && strongGroups.has(groups.get(c.id)!)))).map(c => c.id)
    return { status: ids.length ? 'accepted' : 'insufficient', ids }
  } }
  return { reranker, evidenceSelector, clear: () => { cached = undefined } }
}
