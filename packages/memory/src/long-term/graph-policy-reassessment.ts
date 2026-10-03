import type { CaptureSnapshot } from './capture-repository'
import type { GraphExtractionResultStore, GraphExtractionRun } from './graph-extraction-result'
import type { GraphNormalizationStore } from './graph-normalization-store'
import { createGraphPredicateRegistry, normalizeGraphExtraction, type GraphEntityRecord } from './graph-identity-normalization'
import type { GraphL1Store, GraphL1Writer } from './graph-l1-write'
import { assessGraphClaim } from './graph-l1-write'
import { autoNormalizeUieGraphFact } from './graph-auto-identity'
import { refreshUieGraphReviewContext } from './local-uie'
import { inferMemoryPrivacy } from './memory-extractor'
import { needsOpenFactRepresentation } from '../graph-core/repository/open-assertions'

export interface GraphPolicyReassessmentResult {
  reviewed: number
  published: number
  deferred: number
  failed: number
}

/** Explicit, bounded re-assessment. Raw extraction and human decisions remain immutable. */
export async function reassessRetainedUieGraphFacts(options: {
  extractions: Pick<GraphExtractionResultStore, 'list'>
  normalization: GraphNormalizationStore
  l1: GraphL1Store
  writer: GraphL1Writer
  captureSnapshot: () => CaptureSnapshot
  scope: GraphEntityRecord['scope']
  limit?: number
  reviewIds?: readonly string[]
  isCurrent?: () => boolean
}): Promise<GraphPolicyReassessmentResult> {
  const { extractions, normalization, l1, writer, captureSnapshot, scope } = options
  const registry = createGraphPredicateRegistry()
  const currentStore = () => options.isCurrent?.() !== false
  const requested = options.reviewIds ? new Set(options.reviewIds) : undefined
  const limit = Math.max(1, Math.min(20, Math.floor(options.limit ?? 20)))
  const stats = { reviewed: 0, published: 0, deferred: 0, failed: 0 }
  const activeSource = (run: GraphExtractionRun): boolean => {
    if (!currentStore()) return false
    const matches = captureSnapshot().sources.filter(source => source.status === 'active'
      && source.scope.ownerId === scope.ownerId && source.scope.agentId === scope.agentId
      && (scope.sessionId === undefined || source.scope.sessionId === scope.sessionId)
      && source.turn?.userMessage === run.sourceText
      && (source.id === run.sourceId || source.messageIds.includes(run.sourceId)))
    return matches.length === 1
  }
  for (const prior of l1.reviews().filter(item => item.status === 'pending' && item.reviewer === 'policy')) {
    if (!currentStore()) break
    if (requested && !requested.has(prior.id)) continue
    if (stats.reviewed >= limit) break
    if (l1.tasks().some(task => task.review.id === prior.id)) { stats.deferred++; continue }
    const retained = extractions.list().find(run => run.id === prior.runId)
    if (!retained || retained.sourceRevision !== prior.sourceRevision || !activeSource(retained)) {
      stats.deferred++; continue
    }
    const run = retained.modelId === 'uie-base' ? refreshUieGraphReviewContext(retained) ?? retained : retained
    const sourceFact = run?.factCandidates.find(fact => fact.id === prior.sourceFactId)
    if (!run || !sourceFact || needsOpenFactRepresentation(run, sourceFact, registry)) {
      stats.deferred++; continue
    }
    const sourcePrivacy = inferMemoryPrivacy(run.sourceText)
    if (sourcePrivacy.sensitivity === 'secret') { stats.deferred++; continue }
    stats.reviewed++
    try {
      const baseline = normalizeGraphExtraction(run, { entities: normalization.entities(),
        aliasDecisions: normalization.aliasDecisions(), scope, registry })
      const automatic = autoNormalizeUieGraphFact(run, sourceFact.id, {
        entities: normalization.entities(), aliases: normalization.aliasDecisions(), scope, registry,
      })
      const fact = (automatic?.normalized ?? baseline).facts.find(item => item.sourceFactId === sourceFact.id)
      if (!fact) { stats.deferred++; continue }
      const review = assessGraphClaim(run, fact, { sensitivity: 'private', sharePolicy: 'local-only' })
      const current = l1.reviews().find(item => item.id === prior.id)
      if (review.id !== prior.id || review.status !== 'approved' || !activeSource(run)
        || current?.status !== 'pending' || current.reviewer !== 'policy') {
        stats.deferred++; continue
      }
      const task = await writer.submit(run, fact, review, automatic?.entities ?? normalization.entities())
      if (!currentStore() || !activeSource(run)) { stats.deferred++; continue }
      if (task?.state !== 'published') { stats.failed++; continue }
      if (automatic) normalization.replaceCatalog([...new Map([...automatic.entities, ...normalization.entities()]
        .map(entity => [entity.ref.id, entity])).values()], normalization.aliasDecisions())
      normalization.appendResult(automatic?.normalized ?? baseline)
      stats.published++
    }
    catch { stats.failed++ }
  }
  return stats
}
