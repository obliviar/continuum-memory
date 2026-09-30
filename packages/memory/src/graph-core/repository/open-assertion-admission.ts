import type { SourceSpan } from '../../long-term/graph-extraction-result'
import type { GraphOpenAssertionRecord, OpenNavigationAdmission, OpenSourceContext } from '../domain/open-assertion-types'

export const OPEN_NAVIGATION_POLICY = 'source-context-navigation-v1'

/** Exact source window, including nearby qualifiers outside the extraction evidence. */
export function backtraceOpenContext(source: string, evidence: SourceSpan): OpenSourceContext {
  let start = Math.max(0, evidence.start - 400), end = Math.min(source.length, evidence.end + 400, start + 1600)
  if (/[\uDC00-\uDFFF]/u.test(source[start] ?? '')) start--
  if (/[\uDC00-\uDFFF]/u.test(source[end] ?? '')) end++
  return { text: source.slice(start, end), span: { start, end }, sourceRole: 'user-message',
    truncated: start > 0 || end < source.length }
}

/** Authorizes source-labelled navigation only, never truth or canonical identity. */
export function assessOpenNavigation(record: GraphOpenAssertionRecord): OpenNavigationAdmission {
  const reasons: string[] = []
  const source = record.sourceContext
  if (!source || source.text.slice(record.evidenceSpan.start - source.span.start,
    record.evidenceSpan.end - source.span.start) !== record.text) reasons.push('missing-exact-context')
  if (source?.truncated) reasons.push('truncated-context')
  const contextText = source?.text ?? record.text
  if (/(如果|假如|倘若|只要|除非|可能|也许|或许|计划|打算|希望|据说|听说|声称|表示|说[：:]?|告诉|询问|是否|请|应该|必须|需要|[?？“”「」"'])/u.test(contextText))
    reasons.push('qualified-or-reported-context')
  if (/(不|没|无|未|并非|否认|禁止|拒绝)/u.test(contextText)) reasons.push('negated-context')
  if (record.participants.some(p => /^(他|她|它|他们|她们|它们|这|那|这里|那里|对方|其)$/u.test(p.text.trim())))
    reasons.push('ambiguous-reference')
  if (/(忽略.*指令|系统提示|密码|密钥|口令|token|api[_ -]?key)/iu.test(contextText)) reasons.push('sensitive-or-instruction-content')
  if (record.sensitivity !== 'normal') reasons.push('sensitive-source')
  if (!Number.isFinite(record.modelScore) || record.modelScore < 0.85) reasons.push('low-extraction-score')
  const relation = record.relationSpan
  if (!relation || !source || relation.start < record.evidenceSpan.start || relation.end > record.evidenceSpan.end
    || source.text.slice(relation.start - source.span.start, relation.end - source.span.start) !== record.relationText)
    reasons.push('relation-not-literal')
  // A model's arbitrary label is not a semantic approval, even if the label occurs nearby.
  if (record.extraction.modelId !== 'local-open-patterns-v1'
    && !record.extraction.modelId.includes('uie')) reasons.push('unverified-extractor')
  return { policyVersion: OPEN_NAVIGATION_POLICY,
    localNavigation: record.review.status === 'rejected' ? 'blocked'
      : record.review.status === 'accepted' || reasons.length === 0 ? 'automatic' : 'candidate-only',
    reasons: record.review.status === 'accepted' ? ['user-confirmed-source-fidelity', ...reasons] : reasons,
    identityMerge: false, claimPublication: false, proactiveUse: false, remoteSharing: false }
}

export function canNavigateOpenAssertion(record: GraphOpenAssertionRecord): boolean {
  return record.review.status !== 'rejected'
    && (record.review.status === 'accepted' || record.admission?.localNavigation === 'automatic')
}
