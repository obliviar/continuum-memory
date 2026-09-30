import type { GraphExtractionRun } from './graph-extraction-result'
import { normalizeGraphExtraction, type GraphEntityRecord } from './graph-identity-normalization'
import type { GraphNormalizationStore } from './graph-normalization-store'
import { assessGraphClaim, type GraphL1Store } from './graph-l1-write'
import { inferMemoryPrivacy } from './memory-extractor'

/** Latest UIE attempt per source revision, excluding any source that already yielded facts. */
export function graphSourcesWithoutFactCandidates(runs: readonly GraphExtractionRun[]): GraphExtractionRun[] {
  const latest = new Map<string, GraphExtractionRun>()
  const withFacts = new Set<string>()
  for (const run of runs) {
    const key = `${run.sourceId}\0${run.sourceRevision}`
    if (run.factCandidates.length || run.assertionCandidates?.length) withFacts.add(key)
    if (run.modelId === 'uie-base' || run.modelId === 'local-open-patterns-v1') {
      // Move retried sources to the end so an empty first batch cannot starve later sources.
      latest.delete(key)
      latest.set(key, run)
    }
  }
  return [...latest].filter(([key]) => !withFacts.has(key)).map(([, run]) => run)
}

/** Restore only missing reviews from retained sources; never replay approval or model extraction. */
export function recoverGraphClaimReviews(runs: readonly GraphExtractionRun[],
  normalization: GraphNormalizationStore, l1: GraphL1Store, scope: GraphEntityRecord['scope']): number {
  const known = new Set([...l1.reviews(), ...l1.tasks().map(task => task.review)]
    .map(review => `${review.runId}\0${review.sourceFactId}`))
  const results = new Map(normalization.results().map(result => [result.runId, result]))
  let recovered = 0
  for (const run of runs) {
    if (run.status === 'failed' || !run.factCandidates.some(fact => !known.has(`${run.id}\0${fact.id}`))) continue
    let normalized = results.get(run.id)
    if (!normalized || run.factCandidates.some(fact => !normalized!.facts.some(item => item.sourceFactId === fact.id))) {
      normalized = normalizeGraphExtraction(run, { entities: normalization.entities(),
        aliasDecisions: normalization.aliasDecisions(), scope })
      normalization.appendResult(normalized)
    }
    for (const fact of normalized.facts) {
      const key = `${run.id}\0${fact.sourceFactId}`
      if (known.has(key) || !run.factCandidates.some(item => item.id === fact.sourceFactId)) continue
      const review = assessGraphClaim(run, fact, inferMemoryPrivacy(run.sourceText))
      // Recovery restores visibility, not authorization to publish old material.
      if (review.status === 'approved') {
        review.status = 'pending'
        review.reason = 'recovered-candidate-needs-review'
      }
      l1.recordReview(review)
      known.add(key)
      recovered++
    }
  }
  return recovered
}
