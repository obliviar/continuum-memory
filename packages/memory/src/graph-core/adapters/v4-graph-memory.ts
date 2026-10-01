import type { AgentGraphMemoryPort, GraphRecallRequest, GraphRecallResult, GraphResult, GraphRecallBudget, GraphEvidenceClaim, GraphScope, GraphRecallFeedback } from '@continuum-memory/contracts'
import { MEMORY_GRAPH_PROTOCOL_VERSION } from '@continuum-memory/contracts'
import type { MemoryV4Repository } from '../../v4/repository/memory-v4-repository'
import type { MemoryEpisodeV4, MemoryFactV4 } from '../../v4/domain/types'
import { createDirectLexicalIndex, DIRECT_LEXICAL_POLICY } from '../recall/direct-lexical'
import { searchDirectStructured } from '../recall/direct-structured'
import { DIRECT_HYBRID_POLICY, DIRECT_SEMANTIC_MIN_COSINE, mergeDirectCandidates, searchDirectSemantic, type DirectSemanticOptions } from '../recall/direct-semantic'
import { collectCurrentL1, claimMatchesTime, entityCandidateText } from './accepted-l1-input'
export { selectRetrievableGraphBundle } from './accepted-l1-input'
import type { GraphSemanticBundle } from '../domain/types'
import { graphHash, V4_SCALAR_MAPPING_POLICY } from './v4-semantic-adapter'
import { planGraphQueryTime } from '../recall/query-time-plan'
import { randomUUID } from 'node:crypto'
import { searchEntityVectorSeeds } from '../recall/entity-vector-seeds'
import { createV4RelationSourceReader } from './v4-relation-sources'
import { createV4L1Store, type V4L1Store } from '../repository/v4-l1-store'
import type { GraphAccessContext } from '../ports/graph-ports'
import { selectRecallCandidates, type CandidateSelectionOptions } from '../recall/candidate-selection'
import { emitRecallDiagnostic, type RecallDiagnostics } from '../recall/recall-diagnostics'

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
  now?: () => number
  utcOffsetMinutes?: number
  semantic?: DirectSemanticOptions
  /** Vector uses only dense hits; hybrid preserves the existing control. No silent fallback in vector mode. */
  retrievalMode?: 'entity-vector' | 'vector' | 'hybrid' | 'lexical'
  /** Separate exact-version Entity embeddings. Required by entity-vector mode. */
  entitySemantic?: DirectSemanticOptions
  /** Candidate pool and final evidence/seed limits are separate. Default has no reranker. */
  candidateSelection?: CandidateSelectionOptions
  entityCandidateLimit?: number
  /** Wide local candidates + separate evidence gate; threshold preserves the old control route. */
  entityClaimCandidates?: 'wide' | 'threshold'
  diagnostics?: RecallDiagnostics
  /** Enabled by default; false preserves the lexical/vector-only evaluation control. */
  structuredRecall?: boolean
  /** Trusted owner-wide session inclusion; requests cannot grant it. */
  includeOwnedSessions?: boolean
  /** Current ready native L1, filtered by retrieval permission, rechecked on every read. */
  acceptedBundle?: () => GraphSemanticBundle | undefined
  /** Optional trusted host access registry for external L1/L2 readers. */
  resolveGraphAccess?: (id: string) => GraphAccessContext | undefined
}

/** Direct L1 scalar recall. Does not advertise relation traversal, history reconstruction or proofs. */
export function createV4GraphMemory(options: V4GraphMemoryOptions): AgentGraphMemoryPort & { invalidate: () => void; l1: V4L1Store } {
  const now = options.now ?? Date.now
  const grants = new Map<string, GraphAccessContext>()
  const l1 = createV4L1Store({ ...options, resolveAccess: id => grants.get(id) ?? options.resolveGraphAccess?.(id) })
  const recalls = new Map<string, { result: GraphRecallResult; at: number }>()
  const feedback = new Map<string, string>()
  const fail = (code: 'invalid-request' | 'scope-denied' | 'unsupported-capability' | 'version-mismatch' | 'stale-projection' | 'budget-exhausted' | 'not-ready', message: string): GraphResult<never> => ({ ok: false, error: { code, message } })
  const allowed = (record: MemoryFactV4 | MemoryEpisodeV4, request: GraphRecallRequest) =>
    options.canRead(structuredClone(record)) && request.sharePolicies.includes(record.sharePolicy) && request.sensitivities.includes(record.sensitivity)
  function invalidate() {
    // Persist before publishing; failed disk writes must not be mistaken for successful erasure.
    l1.invalidate()
    recalls.clear()
    feedback.clear()
  }
  return {
    invalidate,
    l1,
    capabilities: () => ({ protocolVersion: MEMORY_GRAPH_PROTOCOL_VERSION, temporal: 'bitemporal', logic: 'none', budgetCeiling: { ...V4_GRAPH_BUDGET } }),
    async recall(request) {
      const start = performance.now()
      try {
        const retrievalMode = options.retrievalMode ?? 'hybrid'
        const vectorMode = retrievalMode === 'vector' || retrievalMode === 'entity-vector'
        if (!['entity-vector', 'vector', 'hybrid', 'lexical'].includes(retrievalMode)) return fail('invalid-request', 'Unknown retrieval mode')
        if (vectorMode && (!options.semantic || (retrievalMode === 'entity-vector' && !options.entitySemantic)))
          return fail('not-ready', 'Vector graph recall requires the local semantic model and the requested indexes')
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
        const gathered = collectCurrentL1(options, request.scope, timestamp)
        const projection = gathered.projection
        const claimByFact = new Map(projection.semanticBundle.claims.map(claim => [claim.fact.id, claim]))
        const includeUnknown = timePlan.value.source === 'caller' && request.temporal.valid.kind === 'at'
          && request.temporal.valid.at === request.temporal.knownAt
        const inputs = gathered.inputs.filter(({ fact, sources }) => {
          if (!allowed(fact, request) || sources.some(s => !allowed(s.episode, request))) return false
          const claim = claimByFact.get(fact.id)!
          return request.sharePolicies.includes(claim.sharePolicy) && request.sensitivities.includes(claim.sensitivity)
            && claimMatchesTime(claim, timePlan.value.temporal, includeUnknown)
        })
        const diagnostic = (stage: Parameters<RecallDiagnostics>[0]['stage'], factIds: string[], details: string[] = []) =>
          emitRecallDiagnostic(options.diagnostics, { recallId: request.recallId, route: 'L1', stage,
            elapsedMs: performance.now() - start, factIds, details })
        diagnostic('eligibility', inputs.map(i => i.fact.id))
        const manifestId = projection.manifest.manifestId
        if (request.expectedManifestId && request.expectedManifestId !== manifestId)
          return fail('version-mismatch', 'Requested L1 manifest is no longer current')
        const index = createDirectLexicalIndex(timePlan.value.lexicalQuery)
        for (const { fact } of vectorMode ? [] : inputs) index.upsert({ id: fact.id, scope: request.scope, state: 'active',
          content: `${fact.canonicalText} ${fact.predicate} ${entityCandidateText(claimByFact.get(fact.id)!, projection, request.sharePolicies, request.sensitivities)}` })
        const lexicalHits = index.search(timePlan.value.lexicalQuery, { scope: request.scope, limit: 10000, minScore: 0.2 })
        const structured = searchDirectStructured(timePlan.value.lexicalQuery, inputs.map(input => input.fact),
          request.scope, retrievalMode === 'hybrid' && options.structuredRecall !== false)
        const semantic = retrievalMode === 'entity-vector' ? await searchEntityVectorSeeds({
          query: timePlan.value.lexicalQuery, projection, entries: inputs.map(({ fact }) => ({ fact, claim: claimByFact.get(fact.id)! })),
          scope: request.scope, temporal: timePlan.value.temporal, sharePolicies: request.sharePolicies, sensitivities: request.sensitivities,
          entitySemantic: options.entitySemantic, claimSemantic: options.semantic,
          claimCandidateMode: options.entityClaimCandidates ?? 'wide',
          entityLimit: request.budget.maxSeeds === 0 ? 0 : Math.min(options.entityCandidateLimit ?? 4, request.budget.maxNodes),
          onLocalCandidates: ids => diagnostic('entity-entry', [...ids]),
          remainingMs: request.budget.maxElapsedMs - (performance.now() - start),
          canReadEntity: entity => createV4RelationSourceReader(options).read(entity.provenance.sources, {
            accessContextId: 'entity-seed', authorizationVersion: 'current', scope: request.scope,
            sharePolicies: request.sharePolicies, sensitivities: request.sensitivities }).ok,
        }) : await searchDirectSemantic(timePlan.value.lexicalQuery, inputs.map(input => input.fact),
          retrievalMode === 'lexical' ? undefined : options.semantic, request.budget.maxElapsedMs - (performance.now() - start))
        if (vectorMode && semantic.incomplete && !semantic.hits.length)
          return fail('not-ready', 'Vector candidate search unavailable or incomplete; no lexical fallback was used')
        if (!options.authorizeScope(request.scope) || graphHash(options.repository.snapshot()) !== graphHash(snapshot))
          return fail('stale-projection', 'Source or authorization changed during candidate retrieval')
        const structuredIds = new Set(structured.hits.map(hit => hit.id))
        const hits = (vectorMode ? semantic.hits : mergeDirectCandidates(lexicalHits, semantic.hits, structured.hits))
          .filter(hit => !structured.constrain || structuredIds.has(hit.id))
        const byId = new Map(inputs.map(input => [input.fact.id, { input, claim: claimByFact.get(input.fact.id)! }]))
        diagnostic('retrieval', hits.map(hit => hit.id), semantic.scope)
        const selection = await selectRecallCandidates({ query: timePlan.value.lexicalQuery, hits,
          admissibleIds: retrievalMode === 'entity-vector' && options.entityClaimCandidates !== 'threshold'
            ? new Set(semantic.hits.filter(h => h.score >= (options.semantic?.minCosine ?? DIRECT_SEMANTIC_MIN_COSINE)).map(h => h.id)) : undefined,
          text: id => byId.get(id)!.input.fact.canonicalText, options: options.candidateSelection,
          finalLimit: Math.min(request.budget.maxSeeds, request.budget.maxNodes),
          remainingMs: request.budget.maxElapsedMs - (performance.now() - start) })
        diagnostic('candidate-pool', selection.candidates.map(hit => hit.id), selection.scope)
        diagnostic('selection', selection.selected.map(hit => hit.id), selection.scope)
        const claims: GraphEvidenceClaim[] = []
        let tokens = 0
        let stopReason: GraphRecallResult['trace']['stopReason'] = selection.selected.length ? 'exhausted-within-scope' : 'no-eligible-seeds'
        if (selection.truncated) stopReason = request.budget.maxNodes <= request.budget.maxSeeds ? 'node-budget' : 'coverage-satisfied'
        let incomplete = selection.truncated || selection.assessmentIncomplete || semantic.incomplete || gathered.rejected.some(item => item.reason !== 'access-denied')
          || inputs.some(i => { const c = claimByFact.get(i.fact.id)!; return c.validTime.kind === 'unknown'
            || c.polarity === 'unknown' || c.modality !== 'asserted' || c.condition.kind !== 'none'
            || projection.semanticBundle.contexts.find(x => graphHash(x.ref) === graphHash(c.context))?.scenario !== 'actual' })
        for (const hit of selection.selected) {
          if (claims.length >= Math.min(request.budget.maxSeeds, request.budget.maxNodes)) {
            stopReason = request.budget.maxNodes <= request.budget.maxSeeds ? 'node-budget' : 'coverage-satisfied'; incomplete = true; break
          }
          const { input, claim } = byId.get(hit.id)!
          const entry: GraphEvidenceClaim = { kind: 'direct', ref: claim.ref, fact: claim.fact,
            citation: `G${claims.length + 1}`, content: input.fact.canonicalText,
            sources: claim.provenance.sources, polarity: claim.polarity, modality: claim.modality,
            conditionText: claim.condition.kind === 'none' ? null : claim.condition.text, context: claim.context, validTime: claim.validTime,
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
        const finalInputs = collectCurrentL1(options, request.scope, now())
        const fresh = new Map(finalInputs.inputs.map(input => [input.fact.id, graphHash(input)]))
        if (!options.authorizeScope(request.scope) || graphHash(finalInputs.projection) !== graphHash(projection)
          || inputs.some(input => fresh.get(input.fact.id) !== graphHash(input)))
          return fail('stale-projection', 'Source or authorization changed during recall')
        const published = l1.publishCurrent({ operationId: request.recallId, scope: request.scope,
          expectedManifestId: l1.snapshot()?.manifest.manifestId ?? null })
        if (!published.ok) return published
        if (published.value.manifestId !== manifestId) return fail('stale-projection', 'L1 changed before publication')
        // Persistence adapters are trusted, but may trigger lifecycle updates while saving.
        if (graphHash(options.repository.snapshot()) !== graphHash(snapshot) || !options.authorizeScope(request.scope)
          || inputs.some(input => !allowed(input.fact, request) || input.sources.some(s => !allowed(s.episode, request))))
          return fail('stale-projection', 'Source or authorization changed during publication')
        if (performance.now() - start >= request.budget.maxElapsedMs) return fail('budget-exhausted', 'Publication exceeded time budget')
        const access: GraphAccessContext = { accessContextId: randomUUID(), authorizationVersion: randomUUID(),
          scope: request.scope, sharePolicies: request.sharePolicies, sensitivities: request.sensitivities }
        grants.set(access.accessContextId, access)
        const opened = await l1.openView({ access, temporal: timePlan.value.temporal, budget: request.budget,
          expectedManifestId: manifestId, policyVersion: V4_SCALAR_MAPPING_POLICY, includeUnknownValidTime: includeUnknown })
        try {
          if (!opened.ok) return opened
          const resolved = await opened.value.resolveClaims(claims.flatMap(c => c.kind === 'direct' ? [c.ref] : []))
          if (!resolved.ok) return resolved
          const facts = await l1.evidenceReader.resolveFactVersions(opened.value, resolved.value.map(c => c.fact))
          if (!facts.ok) return facts
          if (facts.value.some((fact, i) => fact.canonicalText !== claims[i]!.content))
            return fail('stale-projection', 'L1 evidence changed before delivery')
        } finally {
          if (opened.ok) await opened.value.close()
          grants.delete(access.accessContextId)
        }
        if (performance.now() - start >= request.budget.maxElapsedMs) return fail('budget-exhausted', 'Fixed L1 read exceeded time budget')
        const refs = claims.map(claim => claim.ref)
        const result: GraphRecallResult = { protocolVersion: MEMORY_GRAPH_PROTOCOL_VERSION, recallId: request.recallId,
          scope: request.scope, manifestId,
          evidence: { protocolVersion: MEMORY_GRAPH_PROTOCOL_VERSION, recallId: request.recallId, manifestId, claims,
            rules: [], proofs: [], groups: claims.map(claim => ({ groupId: claim.citation, root: claim.ref,
              claimRefs: [claim.ref], ruleRefs: [], proofRefs: [] })) },
          trace: { recallId: request.recallId, manifestId, policyVersion: V4_SCALAR_MAPPING_POLICY,
            temporal: timePlan.value.temporal, completeness: incomplete ? 'incomplete' : 'complete-within-declared-scope',
            searchScope: ['current-verified-scalar-L1', `retrieval-mode:${retrievalMode}`,
              ...(vectorMode ? ['seed-selection:vector', 'no-lexical-fallback'] : ['BM25', DIRECT_LEXICAL_POLICY, DIRECT_HYBRID_POLICY]),
              ...semantic.scope, ...structured.scope, ...selection.scope, 'accepted-entity-L1', 'entity-name-alias-candidates',
              options.includeOwnedSessions && request.scope.sessionId === undefined ? 'trusted-owner-wide-sessions' : 'exact-owner-agent-session',
              'no-L2', 'no-conflict-audit',
              ...(gathered.rejected.length ? ['some-V4-records-excluded'] : [])], stopReason,
            candidateRefs: selection.candidates.map(hit => byId.get(hit.id)!.claim.ref), evaluatedRefs: refs, selectedRefs: refs,
            usage: { seeds: claims.length, nodes: claims.length, edges: 0, maxHopReached: 0, ruleBindings: 0,
              proofSteps: 0, elapsedMs: performance.now() - start, evidenceTokens: tokens }, rejected: [] } }
        diagnostic('delivery', claims.flatMap(claim => claim.kind === 'direct' ? [claim.fact.id] : []), [stopReason])
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
