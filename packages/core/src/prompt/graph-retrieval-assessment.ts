import type { GraphRecallResult } from '@continuum-memory/contracts'

const key = (ref: { kind: string; id: string; version: number }) => JSON.stringify([ref.kind, ref.id, ref.version])

/** Describe returned evidence, never its truth or the absence of records outside this search. */
export function assessGraphRetrieval(result: GraphRecallResult) {
  const { evidence, trace } = result
  const relations = evidence.relations ?? [], context = evidence.relationRecall
  const scope = new Set(trace.searchScope)
  const relationQuery = !!context || !!relations.length || scope.has('reviewed-L2')
  const limitations: string[] = []
  const assessmentTags = trace.searchScope.filter(s => s.startsWith('evidence-assessment:'))
  const relevanceAssessment = assessmentTags.some(s => s.startsWith('evidence-assessment:ambiguous:')) ? 'ambiguous'
    : assessmentTags.some(s => s.startsWith('evidence-assessment:insufficient:')) ? 'insufficient'
    : assessmentTags.some(s => ['evidence-assessment:failed-or-timeout-abstain', 'evidence-assessment:budget-skipped'].includes(s)) ? 'unavailable'
    : assessmentTags.some(s => s.startsWith('evidence-assessment:accepted:')) ? 'accepted-for-retrieval'
    : scope.has('evidence-assessment:conservative-retrieval-gate') ? 'conservative-score-gate' : 'not-assessed'
  if (relevanceAssessment === 'ambiguous') limitations.push('ambiguous-relevance')
  if (relevanceAssessment === 'unavailable') limitations.push('relevance-check-unavailable')
  if (trace.completeness === 'incomplete') limitations.push('incomplete-coverage')
  if (trace.stopReason === 'hop-budget' || context?.depthFrontier.length) limitations.push('hop-limit')
  if (['node-budget', 'edge-budget', 'binding-budget', 'proof-budget', 'time-budget', 'evidence-budget'].includes(trace.stopReason))
    limitations.push('resource-limit')
  if (scope.has('seed-top-k-truncated')) limitations.push('seed-limit')
  if (scope.has('entity-top-k-truncated')) limitations.push('entity-limit')
  if (scope.has('entity-navigation-candidate-pool-truncated')) limitations.push('entity-candidate-pool-limit')
  if (scope.has('entity-fragments-truncated')) limitations.push('entity-text-coverage-limit')
  if (scope.has('semantic-incomplete')) limitations.push('semantic-incomplete')
  if (scope.has('seed-entity-target:ambiguous-identity')) limitations.push('ambiguous-identity')
  // Only fixed diagnostic names reach this summary. Source text cannot add instructions or labels.
  const rejectedBy = ['target-anchors-unresolved', 'target-state-unresolved', 'no-content-match',
    'entity-target-unresolved', 'no-matching-candidate']
    .filter(reason => scope.has(`seed-abstention:${reason}`))
  const roots = context?.paths.filter(path => path.depth === 0).map(path => {
    const matching = relations.filter(relation => context.kinds.includes(relation.kind)
      && ((context.direction !== 'in' || relation.kind === 'contradicts') && key(relation.from) === key(path.root)
        || (context.direction !== 'out' || relation.kind === 'contradicts') && key(relation.to) === key(path.root)))
    return {
      citation: evidence.claims.find(claim => key(claim.ref) === key(path.root))!.citation,
      status: context.maxHops === 0 ? 'not-expanded'
        : matching.length ? 'relations-returned' : 'no-matching-relations-returned',
      relations: matching.map(relation => relation.citation),
    }
  }) ?? []
  return {
    route: relationQuery ? 'relations' : 'direct-facts',
    status: relationQuery
      ? !evidence.claims.length ? 'no-target-evidence' : !relations.length ? 'target-only' : 'relation-evidence'
      : evidence.claims.length ? 'direct-evidence' : 'no-direct-evidence',
    relevanceAssessment, limitations, rejectedBy, roots,
  }
}

export function graphAssessmentGuidance(assessment: ReturnType<typeof assessGraphRetrieval>): string {
  if (assessment.relevanceAssessment === 'ambiguous')
    return 'Candidate relevance is ambiguous. Ask for clarification when needed; do not choose a personal fact solely by similarity.'
  if (assessment.relevanceAssessment === 'unavailable')
    return 'The evidence relevance check could not complete. Do not treat this as proof that the personal fact does not exist.'
  if (assessment.relevanceAssessment === 'insufficient')
    return 'The retrieved candidates were not sufficient to support this question. Do not substitute the highest-similarity candidate for evidence.'
  switch (assessment.status) {
    case 'no-target-evidence':
      return 'No eligible target evidence was returned. Do not claim the event never happened or its cause does not exist.'
    case 'target-only':
      return 'Target statements were returned without the requested relation evidence. You may cite the event, but cannot establish its cause, effect or sequence. A limited search is not a negative fact.'
    case 'relation-evidence':
      return 'Check each root separately: relations for one target do not answer every target. State relevant search limits; do not call the returned causes or paths exhaustive.'
    case 'no-direct-evidence':
      return 'No eligible direct evidence was returned. This does not establish a negative fact about the user.'
    default:
      return 'Direct statements support only their recorded content; they do not establish unrecorded relationships.'
  }
}
