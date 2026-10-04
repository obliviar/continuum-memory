import { randomUUID } from 'node:crypto'
import type { AgentGraphMemoryPort, GraphRecallResult, GraphResult, GraphScope, GraphEvidenceClaim, GraphEvidenceRelation } from '@continuum-memory/contracts'
import type { GraphClaimRecord, GraphProjectionSnapshot } from '../domain/types'
import type { MemoryFactV4 } from '../../v4/domain/types'
import { createV4GraphMemory, V4_GRAPH_BUDGET, type V4GraphMemoryOptions } from './v4-graph-memory'
import { graphHash, V4_SCALAR_MAPPING_POLICY } from './v4-semantic-adapter'
import { createGraphRelationRepository, createEmptyGraphRelationSnapshot, type GraphRelationPersistence, type GraphRelationRepository } from '../repository/relation-repository'
import { createGraphRelationReadPort } from '../repository/relation-read-port'
import { createL2GraphRecallAdapter } from '../recall/l2-recall-adapter'
import { createBoundedGraphRecall } from '../recall/bounded-graph-recall'
import { DIRECT_SEMANTIC_MIN_COSINE, searchDirectSemantic, mergeDirectCandidates } from '../recall/direct-semantic'
import { validL2SemanticFallback, selectL2SemanticFallback, type L2SemanticFallbackOptions } from '../recall/l2-semantic-fallback'
import { rankL2Seeds } from '../recall/l2-seed-ranking'
import { hasGraphRelationIntent, planGraphQuery } from '../recall/query-plan'
import { createV4RelationSourceReader } from './v4-relation-sources'
import { createV4RelationReview } from './v4-relation-review'
import type { GraphAccessContext } from '../ports/graph-ports'
import { createNativeL1ReadAdapter } from './native-l1-read-adapter'
import { claimMatchesTime, entityCandidateNames, entityCandidateBindings } from './accepted-l1-input'
import type { L2EntityBinding } from '../recall/l2-entity-target'
import { assertGraphRelationSnapshot } from '../domain/relation-core'
import { searchEntityVectorSeeds } from '../recall/entity-vector-seeds'
import { candidateLimit } from '../recall/candidate-selection'
import { selectWithSupplementaryRecall } from '../recall/supplementary-recall'
import { createEvidenceSelectionText, evidenceSelectionGroup } from '../recall/evidence-selection-text'
import { emitRecallDiagnostic, type RecallDiagnostics } from '../recall/recall-diagnostics'
import { createEndpointVectorRelationRanker, type RelationPriorityOptions } from '../recall/relation-priority'
import { parseTurnFactFence, isTurnFactVisible } from '../recall/turn-fact-fence'

export const V4_L2_BUDGET = { ...V4_GRAPH_BUDGET, maxSeeds: 4, maxNodes: 32, maxEdges: 32, maxHops: 2, maxEvidenceTokens: 12000 }
export interface V4L2MemoryOptions extends V4GraphMemoryOptions {
  /** Required for the legacy isolated L2 path; native mode reads its authoritative repository instead. */
  relationPersistence?: GraphRelationPersistence
  /** Explicit experimental fallback; never auto-enabled by native or desktop mode. */
  semanticFallback?: L2SemanticFallbackOptions
  /** Explicit opt-in; lexical baseline and unconfigured callers keep authoritative neighbor order. */
  relationPriority?: Pick<RelationPriorityOptions, 'windowSize' | 'timeoutMs'>
  /** When configured, the native reviewed repository is authoritative. No fallback to the legacy file. */
  nativeRelations?: {
    projection: () => GraphProjectionSnapshot | undefined
    repository: () => GraphRelationRepository | undefined
  }
}
const failure = (code: 'not-ready' | 'scope-denied' | 'invalid-request' | 'unsupported-capability' | 'stale-projection' | 'budget-exhausted' | 'version-mismatch', message: string): GraphResult<never> => ({ ok: false, error: { code, message } })

/** Preserve accepted records, but revoke their view before any V4 source mutation. */
export function invalidateV4RelationCheckpoint(persistence: GraphRelationPersistence): void {
  const payload = persistence.load(); if (!payload || payload === '{}') return
  const snapshot = JSON.parse(payload)
  if (!snapshot?.manifest) throw new Error('Invalid L2 checkpoint')
  if (snapshot.manifest.state === 'stale') return
  snapshot.manifest = { ...snapshot.manifest, manifestId: `stale:${randomUUID()}`, state: 'stale' }
  persistence.save(JSON.stringify(snapshot))
}

/** Direct facts and reviewed L2 relations share one Agent port; no candidate/NLI auto-promotion. */
export function createV4L2Memory(options: V4L2MemoryOptions) {
  if (!options.nativeRelations && !options.relationPersistence)
    throw new Error('L2 requires an authoritative native repository or legacy relation persistence')
  const now = options.now ?? Date.now
  const grants = new Map<string, GraphAccessContext>()
  const sources = createV4RelationSourceReader(options)
  // Review tokens and delivery checks track the selected authority, including candidate/observation changes.
  const relationState: GraphRelationPersistence = options.nativeRelations ? {
    load: () => JSON.stringify(options.nativeRelations!.repository()?.snapshot() ?? null),
    save: () => { throw new Error('Native relation writes must use the authoritative repository') },
  } : options.relationPersistence!
  let checkpoint: string | undefined, core: ReturnType<typeof createV4GraphMemory> | undefined
  const corePort = () => {
    const disk = options.persistence.load()
    if (!core || disk !== checkpoint) {
      core = createV4GraphMemory({ ...options, resolveGraphAccess: id => grants.get(id) ?? options.resolveGraphAccess?.(id) })
      checkpoint = disk
    }
    return core
  }
  /** Trusted host write entry. A stale repository requires explicit review/rebuild, never automatic rebinding. */
  function prepareRelations(scope: GraphScope): GraphResult<{
    core: ReturnType<typeof createV4GraphMemory>; repository: GraphRelationRepository; candidates: readonly GraphClaimRecord[]
  }> {
    const port = corePort()
    const published = port.l1.publishCurrent({ scope, operationId: randomUUID(), expectedManifestId: port.l1.snapshot()?.manifest.manifestId ?? null })
    if (!published.ok) return published
    checkpoint = options.persistence.load()
    const current = port.l1.snapshot()!
    if (options.nativeRelations) {
      const native = options.nativeRelations.projection(), repository = options.nativeRelations.repository()
      if (!native || !repository) return failure('not-ready', 'Native reviewed L2 is not ready')
      const snapshot = repository.snapshot()
      if (snapshot.manifest.state !== 'ready' || snapshot.manifest.coreManifestId !== native.manifest.manifestId
        || snapshot.manifest.sourceBundleId !== native.semanticBundle.bundleId)
        return failure('stale-projection', 'Native L1 and reviewed L2 require synchronization')
      assertGraphRelationSnapshot(snapshot, native)
      const nativeClaims = new Map(native.semanticBundle.claims.map(c => [graphHash(c.ref), c]))
      const l1 = createNativeL1ReadAdapter({ base: port.l1, projection: () =>
        options.nativeRelations!.repository() === repository ? options.nativeRelations!.projection() : undefined })
      return { ok: true as const, value: { core: { ...port, l1 }, repository,
        candidates: current.semanticBundle.claims.filter(c => graphHash(nativeClaims.get(graphHash(c.ref)) ?? null) === graphHash(c)) } }
    }
    const legacyPersistence = options.relationPersistence!
    const saved = legacyPersistence.load()
    if (saved && saved !== '{}') {
      const parsed = JSON.parse(saved)
      if (parsed.manifest?.coreManifestId !== current.manifest.manifestId) invalidateV4RelationCheckpoint(legacyPersistence)
    }
    else legacyPersistence.save(JSON.stringify(createEmptyGraphRelationSnapshot(current, now())))
    const repository = createGraphRelationRepository({ coreSnapshot: () => port.l1.snapshot()!, now,
      persistence: { ...legacyPersistence, load: () => {
        const value = legacyPersistence.load(); return value === '{}' ? undefined : value
      } }, verifySources: sources.verify })
    return { ok: true as const, value: { core: port, repository, candidates: current.semanticBundle.claims } }
  }
  const receipts = new Map<string, GraphRecallResult>()
  const feedback = new Map<string, string>()
  const agent: AgentGraphMemoryPort = {
    capabilities: () => ({ protocolVersion: 'memory-graph/v1', temporal: 'bitemporal', logic: 'none', budgetCeiling: { ...V4_L2_BUDGET } }),
    async recall(request) {
      const start = performance.now()
      try {
        request = structuredClone(request)
        const fence = parseTurnFactFence(request.visibleFacts)
        if (!fence.ok) return fence
        const retrievalMode = options.retrievalMode ?? 'hybrid'
        const vectorMode = retrievalMode === 'vector' || retrievalMode === 'entity-vector'
        if (!['entity-vector', 'vector', 'hybrid', 'lexical'].includes(retrievalMode)) return failure('invalid-request', 'Unknown retrieval mode')
        if (vectorMode && (!options.semantic || (retrievalMode === 'entity-vector' && !options.entitySemantic)))
          return failure('not-ready', 'Vector graph recall requires the local semantic model and the requested indexes')
        if (request.protocolVersion !== 'memory-graph/v1' || !request.recallId?.trim() || !request.query?.trim() || request.query.length > 2000
          || !Array.isArray(request.sharePolicies) || !Array.isArray(request.sensitivities) || !request.temporal
          || request.mode !== 'direct-only' || request.expectedHierarchyManifestId || !request.budget
          || Object.keys(V4_L2_BUDGET).some(k => { const key = k as keyof typeof V4_L2_BUDGET
            return !Number.isSafeInteger(request.budget[key]) || request.budget[key] < 0 || request.budget[key] > V4_L2_BUDGET[key] }))
          return failure('invalid-request', 'Unsupported graph request or budget')
        if (!options.authorizeScope(request.scope)) return failure('scope-denied', 'Graph scope denied')
        const planned = planGraphQuery({ query: request.query, relationModel: 'l2', temporal: request.temporal,
          timePlanning: { referenceTime: now(), utcOffsetMinutes: options.utcOffsetMinutes ?? 0 } })
        if (!planned.ok) return planned
        const relationQuestion = planned.value.status === 'ready' || hasGraphRelationIntent(request.query)
        if (!relationQuestion) {
          const budget = { ...request.budget }
          for (const k of Object.keys(V4_GRAPH_BUDGET)) { const key = k as keyof typeof budget; budget[key] = Math.min(budget[key], V4_GRAPH_BUDGET[key]) }
          const result = await corePort().recall({ ...request, budget }); checkpoint = options.persistence.load(); return result
        }
        if (planned.value.status !== 'ready') return failure('unsupported-capability',
          `Clarify the target event and relation question: ${planned.value.clarificationReasons.join(', ')}`)
        const prepared = prepareRelations(request.scope); if (!prepared.ok) return prepared
        const { core: current, repository } = prepared.value
        const projection = current.l1.snapshot()!, relationSnapshot = repository.snapshot()
        const relationCheckpoint = relationState.load()
        if (request.expectedManifestId && request.expectedManifestId !== projection.manifest.manifestId)
          return failure('version-mismatch', 'Requested L1 changed')
        if (relationSnapshot.manifest.state !== 'ready') return failure('stale-projection', 'L2 requires reviewed republication for the current L1')
        const access: GraphAccessContext = { accessContextId: randomUUID(), authorizationVersion: randomUUID(),
          scope: structuredClone(request.scope), sharePolicies: [...request.sharePolicies], sensitivities: [...request.sensitivities] }
        grants.set(access.accessContextId, access)
        const diagnostic = (stage: Parameters<RecallDiagnostics>[0]['stage'], factIds: string[], details: string[] = []) =>
          emitRecallDiagnostic(options.diagnostics, { recallId: request.recallId, route: 'L2', stage,
            elapsedMs: performance.now() - start, factIds, details })
        let semanticIncomplete = false
        const seedSearchScope: string[] = []
        let candidateRefs: GraphClaimRecord['ref'][] = []
        try {
          const claimsByRef = new Map(projection.semanticBundle.claims.map(claim => [graphHash(claim.ref), claim]))
          const relationRead = createGraphRelationReadPort({ repository, isCoreViewLive: current.l1.isViewLive,
            allowRelation: relation => [relation.from, relation.to].every(ref => {
              const claim = claimsByRef.get(graphHash(ref))
              return !!claim && isTurnFactVisible(fence.value, claim.fact)
            }),
            verifySources: async (refs, grant) => { const r = sources.read(refs, grant); return r.ok ? { ok: true, value: undefined } : r } })
          const bridge = createL2GraphRecallAdapter({ coreReadPort: current.l1, relationReadPort: relationRead,
            coreEvidenceReader: current.l1.evidenceReader, countTokens: options.countTokens,
            readRelationSources: async (_view, refs) => sources.read(refs, access),
            searchSeeds: async (search, view) => {
              const eligible: { claim: GraphClaimRecord; fact: MemoryFactV4 }[] = []
              const catalog: L2EntityBinding[] = []
              const bindings = new Map<string, L2EntityBinding[]>()
              const facts = new Map(options.repository.snapshot().facts.map(f => [f.id, f]))
              // Eligibility is checked by the pinned core reader; denied/time-incompatible records never enter vector search.
              for (const claim of prepared.value.candidates) {
                if (!isTurnFactVisible(fence.value, claim.fact)
                  || !access.sharePolicies.includes(claim.sharePolicy) || !access.sensitivities.includes(claim.sensitivity)
                  || claim.review.status !== 'accepted' || claim.review.reviewedAt > search.temporal.knownAt
                  || claim.transactionTime.recordedAt > search.temporal.knownAt || claim.transactionTime.closedAt !== null) continue
                const refs = entityCandidateBindings(claim, projection, access.sharePolicies, access.sensitivities, search.temporal.knownAt)
                bindings.set(graphHash(claim.ref), refs); catalog.push(...refs)
                if (!claimMatchesTime(claim, search.temporal)) continue
                const fact = facts.get(claim.fact.id)
                if (fact) eligible.push({ claim, fact })
              }
              const fallback = retrievalMode === 'hybrid' ? options.semanticFallback : undefined
              diagnostic('eligibility', eligible.map(entry => entry.fact.id))
              const fallbackValid = fallback && validL2SemanticFallback(fallback, options.semantic)
              const protectedQueryTerms = [...projection.semanticBundle.entities.flatMap(e => [e.canonicalName, ...e.aliases]),
                ...eligible.flatMap(({ fact }) => typeof fact.object === 'string' ? [fact.object] : [])]
              const semanticOptions = options.semantic && { ...options.semantic, protectedQueryTerms }
              const entityOptions = options.entitySemantic && { ...options.entitySemantic, protectedQueryTerms }
              const baseEntityLimit = request.budget.maxSeeds === 0 ? 0 : Math.min(options.entityCandidateLimit ?? 4, request.budget.maxNodes)
              const searchSemantic = async (entityLimit: number) => retrievalMode === 'entity-vector' ? await searchEntityVectorSeeds({
                query: search.query, projection, entries: eligible, scope: search.scope, temporal: search.temporal,
                sharePolicies: access.sharePolicies, sensitivities: access.sensitivities,
                entitySemantic: entityOptions, claimSemantic: semanticOptions,
                claimCandidateMode: options.entityClaimCandidates ?? 'wide',
                textMode: options.entityRetrievalTextMode,
                entitySelection: options.entityCandidateSelection,
                entityLimit,
                onLocalCandidates: ids => diagnostic('entity-entry', [...ids]),
                remainingMs: request.budget.maxElapsedMs - (performance.now() - start),
                canReadEntity: entity => sources.read(entity.provenance.sources, access).ok,
                canReadClaim: claim => sources.read(claim.provenance.sources, access).ok,
              }) : await searchDirectSemantic(search.query, [...new Map(eligible.map(e => [e.fact.id, e.fact])).values()],
                retrievalMode === 'lexical' ? undefined : fallbackValid ? { ...semanticOptions!, minCosine: fallback.minCosine } : semanticOptions,
                request.budget.maxElapsedMs - (performance.now() - start))
              const semantic = await searchSemantic(baseEntityLimit)
              if (vectorMode && semantic.incomplete && !semantic.hits.length)
                return failure('not-ready', 'Vector candidate search unavailable or incomplete; no lexical fallback was used')
              semanticIncomplete ||= semantic.incomplete
              const byClaim = new Map(eligible.map(e => [graphHash(e.claim.ref), e]))
              const documents = eligible.map(({ fact, claim }) => ({
                id: graphHash(claim.ref), factId: fact.id, text: fact.canonicalText, predicate: fact.predicate,
                entityNames: entityCandidateNames(claim, projection, access.sharePolicies, access.sensitivities),
                entityBindings: bindings.get(graphHash(claim.ref)),
              }))
              const wideLocal = retrievalMode === 'entity-vector' && options.entityClaimCandidates !== 'threshold'
              const thresholdHits = semantic.hits.filter(hit => hit.score >= (options.semantic?.minCosine ?? DIRECT_SEMANTIC_MIN_COSINE))
              const normalHits = wideLocal ? semantic.hits : thresholdHits
              const poolLimit = candidateLimit(options.candidateSelection)
              let ranked = rankL2Seeds(search.query, search.scope, documents, normalHits, poolLimit, catalog,
                retrievalMode === 'entity-vector' ? 'vector' : retrievalMode)
              if (fallback) {
                if (!fallbackValid) seedSearchScope.push('semantic-fallback:invalid-config')
                else if (ranked.items.length) seedSearchScope.push('semantic-fallback:not-needed')
                else if (request.budget.maxSeeds === 0) seedSearchScope.push('semantic-fallback:seed-budget-zero')
                else {
                  const extra = selectL2SemanticFallback(semantic, fallback)
                  seedSearchScope.push(...extra.scope)
                  if (extra.hits.length) {
                    const proposed = rankL2Seeds(search.query, search.scope, documents, extra.hits, poolLimit, catalog)
                    seedSearchScope.push(proposed.items.length ? 'semantic-fallback:admitted' : 'semantic-fallback:target-mismatch')
                    if (proposed.items.length) ranked = proposed
                  }
                }
              }
              diagnostic('retrieval', ranked.items.map(hit => byClaim.get(hit.id)!.fact.id), [...ranked.scope, ...semantic.scope])
              const selectionPredicates = new Map(projection.semanticBundle.predicates.map(p => [p.name, p]))
              const selectionText = createEvidenceSelectionText({ query: search.query,
                entities: projection.semanticBundle.entities, knownAt: search.temporal.knownAt,
                sharePolicies: access.sharePolicies, sensitivities: access.sensitivities,
                canReadEntity: entity => sources.read(entity.provenance.sources, access).ok })
              const firstRanked = ranked
              const selection = await selectWithSupplementaryRecall({ query: search.query,
                enabled: options.supplementaryRecall, protectedQueryTerms, searchScope: [...semantic.scope, ...ranked.scope],
                searchAgain: async (limit, signal) => {
                  const extra = await searchSemantic(Math.min(32, request.budget.maxNodes, baseEntityLimit * 2))
                  signal.throwIfAborted()
                  semanticIncomplete ||= extra.incomplete
                  const extraHits = wideLocal ? extra.hits : extra.hits.filter(h => h.score >= (options.semantic?.minCosine ?? DIRECT_SEMANTIC_MIN_COSINE))
                  const combined = mergeDirectCandidates(normalHits, extraHits)
                  ranked = rankL2Seeds(search.query, search.scope, documents, combined, limit, catalog,
                    retrievalMode === 'entity-vector' ? 'vector' : retrievalMode)
                  diagnostic('retrieval', ranked.items.map(h => byClaim.get(h.id)!.fact.id), ['supplementary-search', ...extra.scope, ...ranked.scope])
                  return { hits: ranked.items.map(h => ({ id: h.id, score: h.relevance })), scope: [...extra.scope, ...ranked.scope],
                    admissibleIds: wideLocal ? new Set(ranked.items.filter(h => [...thresholdHits, ...extra.hits.filter(x => x.score >= (options.semantic?.minCosine ?? DIRECT_SEMANTIC_MIN_COSINE))]
                      .some(x => x.id === byClaim.get(h.id)!.fact.id)).map(h => h.id)) : undefined }
                },
                admissibleIds: wideLocal ? new Set(ranked.items.filter(hit => thresholdHits.some(h => h.id === byClaim.get(hit.id)!.fact.id)).map(hit => hit.id)) : undefined,
                hits: ranked.items.map(hit => ({ id: hit.id, score: hit.relevance })),
                text: id => { const entry = byClaim.get(id)!; return selectionText(entry.claim, entry.fact.canonicalText) }, options: options.candidateSelection,
                literal: id => byClaim.get(id)!.fact.object,
                group: id => { const claim = byClaim.get(id)!.claim; return evidenceSelectionGroup(claim, selectionPredicates.get(claim.atom.predicate)) },
                finalLimit: request.budget.maxSeeds, remainingMs: request.budget.maxElapsedMs - (performance.now() - start) })
              const original = new Map([...firstRanked.items, ...ranked.items].map(hit => [hit.id, hit]))
              seedSearchScope.push(...ranked.scope.filter(s => !s.startsWith('seed-selected:')), ...semantic.scope, ...selection.scope,
                `seed-selected:${selection.selected.length}`, ...(selection.truncated ? ['seed-top-k-truncated'] : []))
              diagnostic('candidate-pool', selection.candidates.map(hit => byClaim.get(hit.id)!.fact.id), selection.scope)
              diagnostic('selection', selection.selected.map(hit => byClaim.get(hit.id)!.fact.id), selection.scope)
              candidateRefs = selection.candidates.map(hit => byClaim.get(hit.id)!.claim.ref)
              const reranked = selection.scope.some(s => s.startsWith('reranker:applied:')) || !!options.candidateSelection?.evidenceSelector
              const items = selection.selected.map((hit, index) => ({ route: original.get(hit.id)!.route,
                // The seed port requires bounded, descending priority, not calibrated probabilities.
                relevance: reranked ? 1 - index / Math.max(1, selection.selected.length) : original.get(hit.id)!.relevance,
                ref: byClaim.get(hit.id)!.claim.ref }))
              const read = await view.resolveClaims(items.map(i => i.ref)); if (!read.ok) return read
              return { ok: true, value: { items, scanned: eligible.length, completion: 'complete' } }
            } })
          const relationPriority = options.relationPriority && options.semantic && retrievalMode !== 'lexical'
            ? { ...options.relationPriority, ranker: createEndpointVectorRelationRanker(options.semantic) } : undefined
          const recalled = await createBoundedGraphRecall({ ...bridge, relationPriority }).recallQuery({ recallId: request.recallId, query: request.query,
            timePlanning: { referenceTime: now(), utcOffsetMinutes: options.utcOffsetMinutes ?? 0 },
            view: { access, temporal: request.temporal, budget: request.budget, policyVersion: V4_SCALAR_MAPPING_POLICY,
              visibleFacts: request.visibleFacts,
              expectedManifestId: projection.manifest.manifestId, expectedRelationManifestId: relationSnapshot.manifest.manifestId } })
          if (!recalled.ok) return recalled
          const traversal = recalled.value.recall
          const ordering = traversal?.relationOrdering
          const orderingScope = ordering ? ['relation-order:per-node-window', 'relation-score:endpoint-vector-mean-v1',
            `relation-order-window:${ordering.windowSize}`, `relation-order-windows:${ordering.windows.length}`,
            `relation-order-elapsed-ms:${Math.round(ordering.windows.reduce((total, window) => total + window.elapsedMs, 0))}`,
            ...(['applied', 'single-candidate', 'budget-skipped', 'fallback-original-order'] as const)
              .map(status => `relation-order-${status}:${ordering.windows.filter(window => window.status === status).length}`),
            'relation-order:no-pruning', 'relation-order:no-global-ranking'] : ['relation-order:source-order']
          diagnostic('relation-ordering', [], orderingScope)
          if (recalled.value.status === 'seed-search-incomplete' || traversal?.stopReason === 'budget-exhausted')
            return failure('budget-exhausted', 'L2 candidate or traversal budget exhausted before complete evidence assembly')
          const claims: GraphEvidenceClaim[] = traversal?.claims.map(({ record: c, canonicalText }, i) => ({ kind: 'direct',
            ref: c.ref, fact: c.fact, citation: `G${i + 1}`, content: canonicalText, sources: c.provenance.sources,
            ...(c.sourceStatement?.qualifiers ? { qualifiers: c.sourceStatement.qualifiers } : {}),
            ...(c.provenance.sources.length > 1 ? { supplementalQuotations: c.provenance.sources.slice(1).map(source => {
              const quotation = traversal.sources.find(item => graphHash(item.ref) === graphHash(source))
              if (!quotation) throw new Error('Supplemental source was not hydrated at its exact version')
              return { source, content: quotation.content }
            }) } : {}),
            polarity: c.polarity, modality: c.modality, conditionText: null, context: c.context, validTime: c.validTime, support: 'unknown' })) ?? []
          const relations: GraphEvidenceRelation[] = traversal?.relations.map((r, i) => {
            const record = r.authoritativeRecord!
            return { ref: record.ref, citation: `R${i + 1}`, from: record.from, to: record.to, kind: record.kind,
              assertionBasis: record.assertionBasis, sources: record.provenance.sources, polarity: record.polarity,
              modality: record.modality, conditionText: null, context: record.context, validTime: record.validTime, support: 'unknown' }
          }) ?? []
          const refs = claims.map(c => c.ref)
          const result: GraphRecallResult = { protocolVersion: 'memory-graph/v1', recallId: request.recallId, scope: request.scope,
            manifestId: projection.manifest.manifestId,
            evidence: { protocolVersion: 'memory-graph/v1', recallId: request.recallId, manifestId: projection.manifest.manifestId,
              claims, relations, relationManifestId: relationSnapshot.manifest.manifestId, rules: [], proofs: [],
              ...(traversal ? { relationRecall: {
                direction: traversal.searchScope.direction,
                kinds: (['entails', 'contradicts', 'causes', 'precedes', 'explains'] as const)
                  .filter(kind => traversal.searchScope.kinds.includes(kind)),
                maxHops: traversal.searchScope.maxHops, pathPolicy: traversal.pathPolicy,
                paths: traversal.paths, depthFrontier: traversal.depthFrontier,
                conflictAudit: 'not-supported' as const,
                causalAlternatives: traversal.causalAlternatives.map(({ target, coverage, causes, hasMultipleCauses, interpretation }) =>
                  ({ target, coverage, causes, hasMultipleCauses, interpretation })),
              } } : {}),
              groups: claims.length ? [{ groupId: 'L2-evidence', root: claims[0]!.ref,
                claimRefs: [claims[0]!.ref, ...claims.slice(1).map(c => c.ref)], ruleRefs: [], proofRefs: [] }] : [] },
            trace: { recallId: request.recallId, manifestId: projection.manifest.manifestId, policyVersion: V4_SCALAR_MAPPING_POLICY,
              temporal: recalled.value.queryPlan.temporal, completeness: 'incomplete',
              searchScope: ['current-verified-L1', 'reviewed-L2', 'source-asserted-relations', 'no-rule-proofs', 'no-exhaustive-conflict-audit',
                ...(fence.value !== undefined ? ['turn-fact-fence:exact-current-versions'] : []),
                `retrieval-mode:${retrievalMode}`, 'relation-read:adjacency-index', ...seedSearchScope, ...orderingScope,
                options.nativeRelations ? 'native-reviewed-L2' : 'legacy-reviewed-L2',
                `question:${recalled.value.queryPlan.questionType}`, `direction:${recalled.value.queryPlan.traversal?.direction}`,
                `missing-information:${recalled.value.queryPlan.missingInformation}`,
                `relation-kinds:${recalled.value.queryPlan.traversal?.kinds.join(',')}`,
                `relations:${relationSnapshot.manifest.manifestId}`, ...(semanticIncomplete ? ['semantic-incomplete'] : []),
                ...(!relations.length ? ['no-eligible-relation-evidence'] : [])],
              stopReason: !traversal ? 'no-eligible-seeds'
                : traversal.stopReason === 'depth-limit' || traversal.stopReason === 'hop-budget' ? 'hop-budget' : 'exhausted-within-scope',
              candidateRefs, evaluatedRefs: refs, selectedRefs: refs, rejected: [],
              usage: { seeds: recalled.value.seeds.items.length, nodes: claims.length, edges: traversal?.scannedEdges ?? 0,
                maxHopReached: Math.max(0, ...traversal?.paths.map(p => p.depth) ?? []), ruleBindings: 0, proofSteps: 0,
                elapsedMs: performance.now() - start, evidenceTokens: 0 } } }
          const cost = options.countTokens(JSON.stringify(result.evidence).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'))
          if (!Number.isSafeInteger(cost) || cost < 0 || cost > Math.max(0, request.budget.maxEvidenceTokens - 2048))
            return failure('budget-exhausted', 'Complete relation evidence exceeds output budget')
          if (performance.now() - start >= request.budget.maxElapsedMs) return failure('budget-exhausted', 'Relation recall time budget exhausted')
          if (!options.authorizeScope(request.scope) || current.l1.snapshot()?.manifest.state !== 'ready'
            || relationState.load() !== relationCheckpoint)
            return failure('stale-projection', 'Source or relation publication changed before delivery')
          const output = { ...result, trace: { ...result.trace, usage: { ...result.trace.usage, evidenceTokens: cost } } }
          diagnostic('delivery', claims.flatMap(claim => claim.kind === 'direct' ? [claim.fact.id] : []),
            [`relations-returned:${relations.length}`, output.trace.stopReason])
          if (receipts.size >= 128) receipts.delete(receipts.keys().next().value!)
          receipts.set(request.recallId, structuredClone(output)); return { ok: true, value: output }
        } finally { grants.delete(access.accessContextId) }
      } catch { return failure('not-ready', 'L2 source validation or persistence unavailable') }
    },
    async reportFeedback(report) {
      const result = receipts.get(report.recallId)
      if (!result) return corePort().reportFeedback(report)
      if (!options.authorizeScope(report.scope)) return failure('scope-denied', 'Feedback scope denied')
      if (report.manifestId !== result.manifestId || graphHash(report.scope) !== graphHash(result.scope)) return failure('version-mismatch', 'Recall receipt mismatch')
      if (report.protocolVersion !== 'memory-graph/v1' || !report.feedbackId?.trim() || !Number.isSafeInteger(report.recordedAt)
        || report.recordedAt > now() || !Array.isArray(report.events) || report.events.some(e =>
          !['injected', 'cited', 'ignored'].includes(e.kind) || !result.trace.selectedRefs.some(r => graphHash(r) === graphHash(e.target))))
        return failure('invalid-request', 'Feedback must refer to returned claims')
      const hash = graphHash(report)
      if (feedback.has(report.feedbackId)) return feedback.get(report.feedbackId) === hash
        ? { ok: true, value: { recorded: false } } : failure('invalid-request', 'Feedback ID reused')
      if (feedback.size >= 1024) feedback.delete(feedback.keys().next().value!)
      feedback.set(report.feedbackId, hash); return { ok: true, value: { recorded: true } }
    },
  }
  return { ...agent, prepareRelations, ...createV4RelationReview({ ...options, relationPersistence: relationState, prepare: prepareRelations }) }
}
