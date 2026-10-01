import { createMemoryBm25Index, tokenizeBm25 } from '../../long-term/bm25-index'

export const DIRECT_LEXICAL_POLICY = 'direct-lexical-bigram-v1'
const ENGLISH_FUNCTION_WORDS = new Set(['i', 'me', 'my', 'you', 'your', 'the', 'a', 'an',
  'what', 'which', 'who', 'when', 'where', 'how', 'why', 'is', 'are', 'am', 'was', 'were',
  'do', 'does', 'did', 'please', 'tell', 'of', 'in', 'at', 'to', 'and', 'or'])

function normalizedText(text: string): string {
  // Replace wrappers with boundaries; never concatenate the Han text on their two sides.
  return text.normalize('NFKC').toLowerCase().replace(/请问|告诉我|用户|是不是|是否|什么|哪些/g, ' ')
}

/** Query-specific lexical index for authorized direct facts only. No polarity or semantic inference. */
export function directLexicalTerms(query: string, text: string): string[] {
  const normalized = normalizedText(query).trim()
  const singleHanQuery = /^[\u3400-\u9fff]$/.test(normalized)
  return (normalizedText(text).match(/[\u3400-\u9fff]+|[a-z0-9]+/g) ?? [])
    .flatMap(run => tokenizeBm25(run))
    .filter(term => (singleHanQuery || !term.startsWith('c:'))
      && !(term.startsWith('w:') && ENGLISH_FUNCTION_WORDS.has(term.slice(2))))
}

export function createDirectLexicalIndex(query: string) {
  // Keep the shared V3/V4 tokenizer unchanged. Only this direct graph route changes matching units.
  return createMemoryBm25Index({ tokenizer: text => directLexicalTerms(query, text) })
}
