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
  const ids = [...new Set([fact.subjectMentionId, ...('mentionId' in fact.object ? [fact.object.mentionId] : []),
    ...(fact.participants?.map(p => p.mentionId) ?? [])])]
  if (!ids.every(id => {
    const mention = run.entityMentions.find(item => item.id === id)
    return mention && Number.isSafeInteger(mention.span.start) && Number.isSafeInteger(mention.span.end)
      && mention.span.start >= start && mention.span.end <= end && mention.span.start < mention.span.end
      && boundary(mention.span.start) && boundary(mention.span.end)
      && run.sourceText.slice(mention.span.start, mention.span.end) === mention.text
      && (!mention.resolvedText || mention.resolvedText === mention.text
        || run.supplementalEvidence?.some(e => e.text.includes(mention.resolvedText!)
          && createHash('sha256').update(e.text).digest('hex') === e.sourceRevision))
  })) return false
  if (fact.registrationKind === 'basic' || fact.sourceAssertionId) {
    const relation = fact.relationSpan
    if (!relation || !Number.isSafeInteger(relation.start) || !Number.isSafeInteger(relation.end)
      || relation.start < start || relation.end > end || relation.start >= relation.end
      || !boundary(relation.start) || !boundary(relation.end)
      || run.sourceText.slice(relation.start, relation.end) !== (fact.relationText ?? fact.predicate)) return false
    if (fact.participants?.some(p => !p.role.trim())
      || new Set(fact.participants?.map(p => p.role)).size !== fact.participants?.length) return false
    if (fact.sourceAssertionId) {
      const original = run.assertionCandidates?.find(item => item.id === fact.sourceAssertionId)
      const signature = (participants: { mentionId: string; role: string }[]) => JSON.stringify(
        [...participants].sort((a, b) => a.role.localeCompare(b.role)))
      if (!original || original.relationText !== (fact.relationText ?? fact.predicate)
        || JSON.stringify(original.relationSpan) !== JSON.stringify(relation)
        || JSON.stringify(original.evidenceSpan) !== JSON.stringify(fact.evidenceSpan)
        || JSON.stringify(original.context) !== JSON.stringify(fact.context)
        || original.modelScore !== fact.modelScore
        || signature(original.participants) !== signature(fact.participants ?? [])) return false
    }
  }
  return 'mentionId' in fact.object || run.sourceText.slice(start, end).includes(fact.object.literal)
}
