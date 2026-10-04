import type { EntityRetrievalDocument } from '../projection/entity-retrieval-projection'
import { graphHash } from '../adapters/v4-semantic-adapter'
import { selectRecallCandidates, type GraphCandidateReranker, type RecallCandidate } from './candidate-selection'

/** Navigation policy only, separate from final Claim reranking and evidence admission. */
export interface EntityCandidateSelectionOptions {
  candidateLimit?: number
  timeoutMs?: number
  reranker?: GraphCandidateReranker
}

const MAX_MATCHED_DOCUMENTS = 4, MAX_RERANK_TEXT = 2048
function boundedText(text: string) {
  let end = Math.min(text.length, MAX_RERANK_TEXT)
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? '') && /[\uDC00-\uDFFF]/.test(text[end] ?? '')) end--
  return text.slice(0, end)
}

/** Caller has already applied exact identity, scope, time and source constraints to documents. */
export async function selectEntityNavigationCandidates(input: {
  query: string
  documents: readonly EntityRetrievalDocument[]
  hits: readonly RecallCandidate[]
  finalLimit: number
  remainingMs: number
  options?: EntityCandidateSelectionOptions
}) {
  const started = performance.now()
  const poolLimit = input.options?.candidateLimit ?? Math.max(16, input.finalLimit)
  if (!Number.isSafeInteger(input.finalLimit) || input.finalLimit < 0 || input.finalLimit > 32
    || !Number.isSafeInteger(poolLimit) || poolLimit < Math.max(1, input.finalLimit) || poolLimit > 256)
    throw new Error('Entity candidate pool must cover the final entity limit and be within [1,256]')
  const documents = new Map(input.documents.map(document => [document.id, document]))
  const grouped = new Map<string, { id: string; score: number; documentIds: string[] }>()
  const seen = new Set<string>()
  const hits = [...input.hits].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
  for (const hit of hits) {
    const document = documents.get(hit.id)
    if (!document || !Number.isFinite(hit.score)) throw new Error('Invalid entity document hit')
    if (seen.has(hit.id)) continue
    seen.add(hit.id)
    const key = graphHash(document.entityRef), previous = grouped.get(key)
    if (!previous) grouped.set(key, { id: key, score: hit.score, documentIds: [hit.id] })
    else {
      previous.score = Math.max(previous.score, hit.score)
      if (previous.documentIds.length < MAX_MATCHED_DOCUMENTS) previous.documentIds.push(hit.id)
    }
  }
  const ranked = [...grouped.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
  const selection = await selectRecallCandidates({ query: input.query, hits: ranked,
    text: id => boundedText(grouped.get(id)!.documentIds.map(key => documents.get(key)!.canonicalText).join('\n\n')),
    finalLimit: input.finalLimit, remainingMs: input.remainingMs - (performance.now() - started),
    // Do not forward an evidence selector. This stage can choose entities, never authorize an answer.
    options: { candidateLimit: poolLimit, timeoutMs: input.options?.timeoutMs, reranker: input.options?.reranker } })
  const selected = selection.selected.map(hit => ({ ...grouped.get(hit.id)!, navigationScore: hit.score }))
  return { selected, candidates: selection.candidates, total: ranked.length, truncated: selection.truncated,
    scope: ['entity-aggregation:max-score', ...selection.scope
      .filter(value => !value.startsWith('evidence-'))
      .map(value => `entity-navigation-${value}`)] }
}
