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
import { searchDirectSemantic } from '../recall/direct-semantic'
import { rankL2Seeds } from '../recall/l2-seed-ranking'
import { planGraphQuery } from '../recall/query-plan'
import { createV4RelationSourceReader } from './v4-relation-sources'
import { createV4RelationReview } from './v4-relation-review'
import type { GraphAccessContext } from '../ports/graph-ports'
import { createNativeL1ReadAdapter } from './native-l1-read-adapter'
import { claimMatchesTime, entityCandidateNames } from './accepted-l1-input'
import { assertGraphRelationSnapshot } from '../domain/relation-core'

export const V4_L2_BUDGET = { ...V4_GRAPH_BUDGET, maxSeeds: 4, maxNodes: 32, maxEdges: 32, maxHops: 2, maxEvidenceTokens: 12000 }
export interface V4L2MemoryOptions extends V4GraphMemoryOptions {
  /** Required for the legacy isolated L2 path; native mode reads its authoritative repository instead. */
  relationPersistence?: GraphRelationPersistence
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
        const relationQuestion = planned.value.status === 'ready'
          || /为什么|为何|原因|导致|先后|之前|之后|以前|以后|\b(why|caus\w*|before|after|effects?|consequences?|related)\b/i.test(request.query)
        if (!relationQuestion) {
          const budget = { ...request.budget }
          for (const k of Object.keys(V4_GRAPH_BUDGET)) { const key = k as keyof typeof budget; budget[key] = Math.min(budget[key], V4_GRAPH_BUDGET[key]) }
          const result = await corePort().recall({ ...request, budget }); checkpoint = options.persistence.load(); return result
        }
        if (planned.value.status !== 'ready') return failure('unsupported-capability', 'Clarify the target event and relation question')
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
        let semanticIncomplete = false
        const seedSearchScope: string[] = []
        try {
          const relationRead = createGraphRelationReadPort({ repository, isCoreViewLive: current.l1.isViewLive,
            verifySources: async (refs, grant) => { const r = sources.read(refs, grant); return r.ok ? { ok: true, value: undefined } : r } })
          const bridge = createL2GraphRecallAdapter({ coreReadPort: current.l1, relationReadPort: relationRead,
            coreEvidenceReader: current.l1.evidenceReader, countTokens: options.countTokens,
            readRelationSources: async (_view, refs) => sources.read(refs, access),
            searchSeeds: async (search, view) => {
              const eligible: { claim: GraphClaimRecord; fact: MemoryFactV4 }[] = []
              const facts = new Map(options.repository.snapshot().facts.map(f => [f.id, f]))
              // Eligibility is checked by the pinned core reader; denied/time-incompatible records never enter vector search.
              for (const claim of prepared.value.candidates) {
                if (!access.sharePolicies.includes(claim.sharePolicy) || !access.sensitivities.includes(claim.sensitivity)
                  || !claimMatchesTime(claim, search.temporal)) continue
                const fact = facts.get(claim.fact.id)
                if (fact) eligible.push({ claim, fact })
              }
              const semantic = await searchDirectSemantic(search.query, [...new Map(eligible.map(e => [e.fact.id, e.fact])).values()], options.semantic,
                request.budget.maxElapsedMs - (performance.now() - start))
              semanticIncomplete ||= semantic.incomplete
              const byClaim = new Map(eligible.map(e => [graphHash(e.claim.ref), e]))
              const ranked = rankL2Seeds(search.query, search.scope, eligible.map(({ fact, claim }) => ({
                id: graphHash(claim.ref), factId: fact.id, text: fact.canonicalText, predicate: fact.predicate,
                entityNames: entityCandidateNames(claim, projection, access.sharePolicies, access.sensitivities),
              })), semantic.hits, request.budget.maxSeeds)
              seedSearchScope.push(...ranked.scope, ...semantic.scope)
              const items = ranked.items.map(({ id, ...hit }) => ({ ...hit, ref: byClaim.get(id)!.claim.ref }))
              const read = await view.resolveClaims(items.map(i => i.ref)); if (!read.ok) return read
              return { ok: true, value: { items, scanned: eligible.length, completion: 'complete' } }
            } })
          const recalled = await createBoundedGraphRecall(bridge).recallQuery({ recallId: request.recallId, query: request.query,
            timePlanning: { referenceTime: now(), utcOffsetMinutes: options.utcOffsetMinutes ?? 0 },
            view: { access, temporal: request.temporal, budget: request.budget, policyVersion: V4_SCALAR_MAPPING_POLICY,
              expectedManifestId: projection.manifest.manifestId, expectedRelationManifestId: relationSnapshot.manifest.manifestId } })
          if (!recalled.ok) return recalled
          const traversal = recalled.value.recall
          if (recalled.value.status === 'seed-search-incomplete' || traversal?.stopReason === 'budget-exhausted')
            return failure('budget-exhausted', 'L2 candidate or traversal budget exhausted before complete evidence assembly')
          const claims: GraphEvidenceClaim[] = traversal?.claims.map(({ record: c, canonicalText }, i) => ({ kind: 'direct',
            ref: c.ref, fact: c.fact, citation: `G${i + 1}`, content: canonicalText, sources: c.provenance.sources,
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
                ...seedSearchScope,
                options.nativeRelations ? 'native-reviewed-L2' : 'legacy-reviewed-L2',
                `question:${recalled.value.queryPlan.questionType}`, `direction:${recalled.value.queryPlan.traversal?.direction}`,
                `relations:${relationSnapshot.manifest.manifestId}`, ...(semanticIncomplete ? ['semantic-incomplete'] : []),
                ...(!relations.length ? ['no-eligible-relation-evidence'] : [])],
              stopReason: !traversal ? 'no-eligible-seeds'
                : traversal.stopReason === 'depth-limit' || traversal.stopReason === 'hop-budget' ? 'hop-budget' : 'exhausted-within-scope',
              candidateRefs: recalled.value.seeds.items.map(s => s.ref), evaluatedRefs: refs, selectedRefs: refs, rejected: [],
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
