import type { AgentGraphMemoryPort, GraphRecallRequest, GraphRecallResult, GraphResult, GraphRecallBudget, GraphEvidenceClaim, GraphScope, GraphRecallFeedback } from '@continuum-memory/contracts'
import { MEMORY_GRAPH_PROTOCOL_VERSION } from '@continuum-memory/contracts'
import type { MemoryV4Repository } from '../../v4/repository/memory-v4-repository'
import type { MemoryEpisodeV4, MemoryFactV4 } from '../../v4/domain/types'
import { createMemoryBm25Index } from '../../long-term/bm25-index'
import { collectV4RecallInputs } from './v4-recall-input'
import { graphHash, projectV4ScalarInputs, V4_SCALAR_MAPPING_POLICY } from './v4-semantic-adapter'
import { planGraphQueryTime } from '../recall/query-time-plan'

export interface V4GraphPersistence { storagePath?: string; load: () => string | undefined; save: (payload: string) => void }
export const V4_GRAPH_BUDGET: GraphRecallBudget = { maxSeeds: 8, maxNodes: 64, maxEdges: 0, maxHops: 0,
  maxRuleBindings: 0, maxProofSteps: 0, maxElapsedMs: 2000, maxEvidenceTokens: 6000 }
export interface V4GraphMemoryOptions {
  repository: MemoryV4Repository
  persistence: V4GraphPersistence
  /** Trusted host authentication, checked on every call; never use request scope as authorization. */
  authorizeScope: (scope: GraphScope) => boolean
  canRead: (record: MemoryFactV4 | MemoryEpisodeV4) => boolean
  /** Exact tokenizer or a documented conservative upper bound (e.g. UTF-8 bytes for byte BPE). */
  countTokens: (text: string) => number
  /** Enable only when the trusted host authorizes cross-session recall for this owner. */
  includeOwnedSessions?: boolean
  now?: () => number
  utcOffsetMinutes?: number
}

/** Direct L1 scalar recall. Does not advertise relation traversal, history reconstruction or proofs. */
export function createV4GraphMemory(options: V4GraphMemoryOptions): AgentGraphMemoryPort & { invalidate: () => void } {
  const now = options.now ?? Date.now
  let persisted = options.persistence.load()
  const recalls = new Map<string, { result: GraphRecallResult; at: number }>()
  const feedback = new Map<string, string>()
  const fail = (code: 'invalid-request' | 'scope-denied' | 'unsupported-capability' | 'version-mismatch' | 'stale-projection' | 'budget-exhausted' | 'not-ready', message: string): GraphResult<never> => ({ ok: false, error: { code, message } })
  const allowed = (record: MemoryFactV4 | MemoryEpisodeV4, request: GraphRecallRequest) =>
    options.canRead(structuredClone(record)) && request.sharePolicies.includes(record.sharePolicy) && request.sensitivities.includes(record.sensitivity)
  function invalidate() {
    // Persist before publishing; failed disk writes must not be mistaken for successful erasure.
    options.persistence.save('{}')
    persisted = '{}'
    recalls.clear()
    feedback.clear()
  }
  return {
    invalidate,
    capabilities: () => ({ protocolVersion: MEMORY_GRAPH_PROTOCOL_VERSION, temporal: 'bitemporal', logic: 'none', budgetCeiling: { ...V4_GRAPH_BUDGET } }),
    async recall(request) {
      const start = performance.now()
      try {
        if (request.protocolVersion !== MEMORY_GRAPH_PROTOCOL_VERSION || !request.recallId?.trim()
          || !request.query?.trim() || request.query.length > 2000 || !request.scope?.ownerId || !request.scope.agentId
          || !Array.isArray(request.sharePolicies) || !Array.isArray(request.sensitivities)
          || !request.budget || Object.keys(V4_GRAPH_BUDGET).some(k => {
            const key = k as keyof GraphRecallBudget
            return !Number.isSafeInteger(request.budget[key]) || request.budget[key] < 0 || request.budget[key] > V4_GRAPH_BUDGET[key]
          })) return fail('invalid-request', 'Invalid request or budget exceeds the direct L1 ceiling')
        if (!options.authorizeScope(request.scope)) return fail('scope-denied', 'Scope not authorized')
        if (request.mode !== 'direct-only' || request.expectedHierarchyManifestId)
          return fail('unsupported-capability', 'Only direct scalar L1 recall is available')
        const timestamp = now()
        const snapshot = options.repository.snapshot()
        if (snapshot.facts.length > 10000) return fail('budget-exhausted', 'V4 import scan ceiling exceeded')
        if (!request.temporal || request.temporal.knownAt < snapshot.updatedAt || request.temporal.knownAt > timestamp)
          return fail('unsupported-capability', 'Historical transaction views are not available in this adapter')
        const timePlan = planGraphQueryTime(request.query, request.temporal, {
          referenceTime: timestamp, utcOffsetMinutes: options.utcOffsetMinutes ?? 0,
        })
        if (!timePlan.ok) return timePlan
        // Do not answer a relation question with unrelated scalar facts as though an edge had been found.
        if (/为什么|为何|原因|导致|先后|先.*后|\b(why|cause|caused|before|after)\b/i.test(request.query))
          return fail('unsupported-capability', 'This host route has no L2 traversal; use the bounded relation service')
        const gathered = collectV4RecallInputs(options.repository, { scope: request.scope, expectedRevision: snapshot.revision,
          includeOwnedSessions: options.includeOwnedSessions,
          now: timestamp, canRead: record => allowed(record, request) })
        const inputs = gathered.inputs.filter(({ fact }) => {
          const valid = timePlan.value.temporal.valid
          return valid.kind === 'at' ? fact.validFrom! <= valid.at && (fact.validTo === undefined || valid.at < fact.validTo)
            : fact.validFrom! < valid.to && (fact.validTo === undefined || valid.from < fact.validTo)
        })
        const projection = projectV4ScalarInputs(inputs, request.scope, snapshot.revision)
        const manifestId = projection.manifest.manifestId
        if (request.expectedManifestId && request.expectedManifestId !== manifestId)
          return fail('version-mismatch', 'Requested L1 manifest is no longer current')
        const index = createMemoryBm25Index()
        for (const { fact } of inputs) index.upsert({ id: fact.id, scope: request.scope, state: 'active',
          content: `${fact.canonicalText} ${fact.predicate}` })
        const hits = index.search(timePlan.value.lexicalQuery, { scope: request.scope, limit: 10000, minScore: 0.2 })
        const byId = new Map(inputs.map((input, i) => [input.fact.id, { input, claim: projection.semanticBundle.claims[i]! }]))
        const claims: GraphEvidenceClaim[] = []
        let tokens = 0
        let stopReason: GraphRecallResult['trace']['stopReason'] = hits.length ? 'exhausted-within-scope' : 'no-eligible-seeds'
        let incomplete = gathered.rejected.some(item => item.reason !== 'access-denied')
        for (const hit of hits) {
          if (claims.length >= Math.min(request.budget.maxSeeds, request.budget.maxNodes)) {
            stopReason = request.budget.maxNodes <= request.budget.maxSeeds ? 'node-budget' : 'coverage-satisfied'; incomplete = true; break
          }
          const { input, claim } = byId.get(hit.id)!
          const entry: GraphEvidenceClaim = { kind: 'direct', ref: claim.ref, fact: claim.fact,
            citation: `G${claims.length + 1}`, content: input.fact.canonicalText,
            sources: claim.provenance.sources, polarity: claim.polarity, modality: claim.modality,
            conditionText: null, context: claim.context, validTime: claim.validTime,
            // Verified source extraction does not certify that competing explanations were exhaustively checked.
            support: 'unknown' }
          const cost = options.countTokens(JSON.stringify(entry).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'))
          if (!Number.isSafeInteger(cost) || cost < 0) throw new Error('Invalid token counter')
          if (tokens + cost > Math.max(0, request.budget.maxEvidenceTokens - 2048)) { stopReason = 'evidence-budget'; incomplete = true; break }
          claims.push(entry); tokens += cost
        }
        const elapsed = performance.now() - start
        if (elapsed >= request.budget.maxElapsedMs) return fail('budget-exhausted', 'Direct recall elapsed-time budget exhausted')
        // Re-read CURRENT tombstones, policy and exact contents even when an encrypted projection exists.
        const finalInputs = collectV4RecallInputs(options.repository, { scope: request.scope, expectedRevision: snapshot.revision,
          includeOwnedSessions: options.includeOwnedSessions,
          now: now(), canRead: record => allowed(record, request) })
        const fresh = new Map(finalInputs.inputs.map(input => [input.fact.id, graphHash(input)]))
        if (!options.authorizeScope(request.scope) || inputs.some(input => fresh.get(input.fact.id) !== graphHash(input)))
          return fail('stale-projection', 'Source or authorization changed during recall')
        const payload = JSON.stringify({ policy: V4_SCALAR_MAPPING_POLICY, projection })
        if (payload !== persisted) { options.persistence.save(payload); persisted = payload }
        // Persistence adapters are trusted, but may trigger lifecycle updates while saving.
        if (graphHash(options.repository.snapshot()) !== graphHash(snapshot) || !options.authorizeScope(request.scope)
          || inputs.some(input => !allowed(input.fact, request) || input.sources.some(s => !allowed(s.episode, request))))
          return fail('stale-projection', 'Source or authorization changed during publication')
        if (performance.now() - start >= request.budget.maxElapsedMs) return fail('budget-exhausted', 'Publication exceeded time budget')
        const refs = claims.map(claim => claim.ref)
        const result: GraphRecallResult = { protocolVersion: MEMORY_GRAPH_PROTOCOL_VERSION, recallId: request.recallId,
          scope: request.scope, manifestId,
          evidence: { protocolVersion: MEMORY_GRAPH_PROTOCOL_VERSION, recallId: request.recallId, manifestId, claims,
            rules: [], proofs: [], groups: claims.map(claim => ({ groupId: claim.citation, root: claim.ref,
              claimRefs: [claim.ref], ruleRefs: [], proofRefs: [] })) },
          trace: { recallId: request.recallId, manifestId, policyVersion: V4_SCALAR_MAPPING_POLICY,
            temporal: timePlan.value.temporal, completeness: incomplete ? 'incomplete' : 'complete-within-declared-scope',
            searchScope: ['current-verified-scalar-L1', 'BM25',
              options.includeOwnedSessions && request.scope.sessionId === undefined
                ? 'trusted-owner-wide-sessions' : 'exact-owner-agent-session',
              'no-L2', 'no-conflict-audit',
              ...(gathered.rejected.length ? ['some-V4-records-excluded'] : [])], stopReason,
            candidateRefs: hits.map(hit => byId.get(hit.id)!.claim.ref), evaluatedRefs: refs, selectedRefs: refs,
            usage: { seeds: claims.length, nodes: claims.length, edges: 0, maxHopReached: 0, ruleBindings: 0,
              proofSteps: 0, elapsedMs: performance.now() - start, evidenceTokens: tokens }, rejected: [] } }
        if (recalls.size >= 128) recalls.delete(recalls.keys().next().value!)
        recalls.set(request.recallId, { result: structuredClone(result), at: timestamp })
        return { ok: true, value: result }
      } catch { return fail('not-ready', 'V4 graph source validation or persistence failed') }
    },
    async reportFeedback(report: GraphRecallFeedback) {
      if (!options.authorizeScope(report.scope)) return fail('scope-denied', 'Scope not authorized')
      const stored = recalls.get(report.recallId)
      if (!stored || now() - stored.at > 3600000 || stored.result.manifestId !== report.manifestId
        || graphHash(stored.result.scope) !== graphHash(report.scope)) return fail('version-mismatch', 'Recall receipt unavailable')
      if (report.protocolVersion !== MEMORY_GRAPH_PROTOCOL_VERSION || !report.feedbackId?.trim()
        || !Number.isSafeInteger(report.recordedAt) || report.recordedAt > now()
        || !Array.isArray(report.events) || report.events.some(event =>
          !['injected', 'cited', 'ignored'].includes(event.kind)
          || !stored.result.trace.selectedRefs.some(ref => graphHash(ref) === graphHash(event.target))))
        return fail('invalid-request', 'Feedback must refer to selected claims and explicit usage events')
      const hash = graphHash(report)
      if (feedback.has(report.feedbackId)) return feedback.get(report.feedbackId) === hash
        ? { ok: true, value: { recorded: false } } : fail('invalid-request', 'Feedback ID reused with different content')
      if (feedback.size >= 1024) feedback.delete(feedback.keys().next().value!)
      feedback.set(report.feedbackId, hash)
      // Session-local usage receipt only; never turn citation into verification or confidence.
      return { ok: true, value: { recorded: true } }
    },
  }
}
