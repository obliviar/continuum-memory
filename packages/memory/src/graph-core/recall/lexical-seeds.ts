import { createMemoryBm25Index, tokenizeBm25 } from '../../long-term/bm25-index'
import type { GraphClaimRecord } from '../domain/types'
import { graphCalendarDates, GRAPH_CALENDAR_DATE } from './calendar-dates'
import { hasUnresolvedGraphTime } from './query-time-plan'

const STOP_WORDS = new Set(['w:why', 'w:what', 'w:when', 'w:where', 'w:how', 'w:did', 'w:does',
  'w:do', 'w:is', 'w:was', 'w:the', 'w:a', 'w:an', 'w:please', 'w:tell', 'w:me'])

/** Deterministic lexical baseline, not semantic entailment or confidence scoring. */
export function prepareGraphLexicalQuery(query: string) {
  if (hasUnresolvedGraphTime(query)) throw new Error('Relative time must be planned before lexical search')
  const dates = extractDates(query)
  if (dates.length > 1) throw new Error('Multiple explicit dates require a query planner')
  return { text: query, dates, terms: new Set(tokenizeGraphText(query)),
    negative: /没有|没去|没上|未曾|未去|未上|\b(?:not|never)\b/i.test(query) }
}

/** The caller supplies ONLY records already eligible in this authorized view. */
export function rankGraphLexicalSeeds(
  query: ReturnType<typeof prepareGraphLexicalQuery>,
  documents: readonly { claim: GraphClaimRecord; content: string }[],
  limit: number,
) {
  if (query.terms.size === 0 || limit <= 0) return []
  const index = createMemoryBm25Index({ tokenizer: tokenizeGraphText })
  const scope = { ownerId: 'eligible-view', agentId: 'lexical' }
  const eligible = new Map<string, GraphClaimRecord>()
  for (const document of documents) {
    // Explicit negation is a narrow guard; absence of this guard does not prove positive polarity.
    if (!matchesGraphSeedQuery(query, document)) continue
    const terms = new Set(tokenizeGraphText(document.content))
    const matched = [...query.terms].filter(term => terms.has(term)).length
    // Fixed baseline threshold, deliberately exposed in docs; not benchmark-calibrated.
    if (matched / query.terms.size < 0.5) continue
    const id = JSON.stringify([document.claim.ref.id, document.claim.ref.version])
    eligible.set(id, document.claim)
    index.upsert({ id, scope, state: 'active', content: document.content })
  }
  return index.search(query.text, { scope, limit, minScore: 0.2 }).map(hit => ({
    ref: eligible.get(hit.id)!.ref, route: 'lexical' as const, relevance: hit.score,
  }))
}

/** Structured entry references may bypass lexical scoring, never explicit date/polarity guards. */
export function matchesGraphSeedQuery(query: ReturnType<typeof prepareGraphLexicalQuery>, document: { claim: GraphClaimRecord; content: string }): boolean {
  if (query.negative && document.claim.polarity !== 'negative') return false
  const dates = new Set([...extractDates(document.content), ...Object.values(document.claim.atom.args)
    .flatMap(term => term.kind === 'date' ? extractDates(term.value) : [])])
  return query.dates.every(date => dates.has(date))
}

function tokenizeGraphText(value: string): string[] {
  // Remove date terms and question phrasing; don't join Han text across dates,
  // punctuation or words to create artificial cross-boundary bigrams.
  const text = value.normalize('NFKC').replace(GRAPH_CALENDAR_DATE, ' ')
    .replace(/为什么|为何|什么原因|请问|怎么会|什么/g, ' ')
  return (text.match(/[\u3400-\u9fff]+|[a-zA-Z0-9]+/g) ?? [])
    .flatMap(run => tokenizeBm25(run)).filter(term => !term.startsWith('c:') && !STOP_WORDS.has(term))
}

function extractDates(value: string): string[] {
  return [...new Set(graphCalendarDates(value.normalize('NFKC')).map(date => date.key))]
}
