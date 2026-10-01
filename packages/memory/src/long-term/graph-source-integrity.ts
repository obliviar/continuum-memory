import { createHash } from 'node:crypto'
import type { FactCandidate, GraphExtractionRun } from './graph-extraction-result'
import { isSafeMemoryContent } from './memory-extractor'

/** Source integrity, not truth or extraction confidence. Used before binding or publication. */
export function graphSourceCandidateValid(run: GraphExtractionRun, fact: FactCandidate): boolean {
  if (run.status !== 'complete' || !isSafeMemoryContent(run.sourceText)
    || createHash('sha256').update(run.sourceText).digest('hex') !== run.sourceRevision)
    return false
  if (!Number.isFinite(fact.modelScore) || fact.modelScore < 0 || fact.modelScore > 1) return false
  const { start, end } = fact.evidenceSpan
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > run.sourceText.length)
    return false
  const boundary = (at: number) => !(/[\uD800-\uDBFF]/u.test(run.sourceText[at - 1] ?? '')
    && /[\uDC00-\uDFFF]/u.test(run.sourceText[at] ?? ''))
  if (!boundary(start) || !boundary(end)) return false
  const ids = [fact.subjectMentionId, ...('mentionId' in fact.object ? [fact.object.mentionId] : [])]
  if (!ids.every(id => {
    const mention = run.entityMentions.find(item => item.id === id)
    return mention && Number.isSafeInteger(mention.span.start) && Number.isSafeInteger(mention.span.end)
      && mention.span.start >= start && mention.span.end <= end && mention.span.start < mention.span.end
      && boundary(mention.span.start) && boundary(mention.span.end)
      && run.sourceText.slice(mention.span.start, mention.span.end) === mention.text
  })) return false
  return 'mentionId' in fact.object || run.sourceText.slice(start, end).includes(fact.object.literal)
}
