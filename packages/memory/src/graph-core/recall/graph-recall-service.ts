import { RECALL_RELATION_KINDS } from '../domain/recall-types'
import type {
  GraphClaimRef, GraphProtocolError, GraphResult, GraphSourceRef,
  GraphVersionRef,
} from '@continuum-memory/contracts'
import { MEMORY_GRAPH_PROTOCOL_VERSION } from '@continuum-memory/contracts'
import type { GraphClaimRecord,  } from '../domain/types'
import type { GraphRecallRelationKind as GraphRelationKind, GraphRecallRelationRecord as GraphRelationRecord } from '../domain/recall-types'
import type { GraphQueryTimeOptions, GraphQueryTimePlan } from './query-time-plan'
import { checkClaimConflicts, unperformedConflictAudit } from './conflict-check'
import type { GraphConflictAudit } from './conflict-check'
import { summarizeCausalAlternatives } from './causal-alternatives'
import type { GraphCausalAlternativeCheck } from './causal-alternatives'
import { buildGraphAnswerEvidence } from './answer-evidence'
import type { GraphRelationManifest } from '../domain/relation-types'
import type { GraphAnswerEvidencePack } from './answer-evidence'
import { planGraphQuery } from './query-plan'
import type { GraphQueryConstraints, GraphQueryPlan } from './query-plan'
import type {
  GraphRecallEvidenceReader as GraphEvidenceReader, GraphRecallNeighborQuery as GraphNeighborQuery, GraphRecallOpenViewRequest as GraphOpenViewRequest,
  GraphRecallReadPort as GraphReadPort, GraphRecallReadView as GraphReadView, GraphSourceContent, GraphRecallSeedPort as GraphSeedPort, GraphPage,
  GraphSeedEntries, GraphSeedCandidate,
} from '../ports/graph-recall-ports'

export interface GraphTraversalRecallRequest {
  readonly recallId: string
  readonly view: GraphOpenViewRequest
  /** Already resolved by the caller; no natural-language seed search here. */
  readonly seed: GraphClaimRef
  readonly direction: GraphNeighborQuery['direction']
  readonly kinds: readonly GraphRelationKind[]
}

export interface QueryGraphTraversalRecallRequest {
  readonly recallId: string
  readonly query: string
  readonly view: GraphOpenViewRequest
  /** Opt in to replacing valid time with parsed query dates; knownAt is preserved. */
  readonly timePlanning?: GraphQueryTimeOptions
  readonly constraints?: GraphQueryConstraints
  /** Optional exact host-resolved entry points, additional to Claim text search. */
  readonly seedEntries?: GraphSeedEntries
  /** Explicit traversal overrides the query planner's type/direction defaults. */
  readonly direction?: GraphNeighborQuery['direction']
  readonly kinds?: readonly GraphRelationKind[]
}

export interface QueryGraphTraversalRecallResult<Depth extends number = number> {
  readonly recallId: string
  readonly timePlan: GraphQueryTimePlan | null
  readonly queryPlan: GraphQueryPlan
  readonly status: 'recalled' | 'no-match' | 'seed-search-incomplete' | 'needs-clarification'
  /** Ranking combines configured seed routes; it is not a probability or causal judgment. */
  readonly selection: 'top-k'
  readonly seeds: GraphPage<Omit<GraphSeedCandidate, 'ref'> & { readonly ref: GraphClaimRef }>
  readonly recall: GraphTraversalRecallResult<Depth> | null
}

export interface GraphTraversalRecallResult<Depth extends number = number> extends GraphTraversalRecallData<Depth> {
  readonly evidencePack: GraphAnswerEvidencePack
}

/** Raw evidence and coverage; the answer pack is built from this before final view revalidation. */
export interface GraphTraversalRecallData<Depth extends number = number> {
  readonly recallId: string
  readonly manifestId: string
  readonly relationManifest?: GraphRelationManifest
  readonly policyVersion: string
  readonly scope: GraphOpenViewRequest['access']['scope']
  readonly temporal: GraphOpenViewRequest['temporal']
  readonly searchScope: {
    readonly seed: GraphClaimRef
    /** All planned roots; seed above is retained as the first root for existing callers. */
    readonly seeds: readonly GraphClaimRef[]
    readonly direction: GraphNeighborQuery['direction']
    readonly kinds: readonly GraphRelationKind[]
    readonly maxHops: Depth
  }
  /** Complete only for eligible relation expansion inside searchScope, never the entire graph. */
  readonly completeness: 'complete-within-declared-scope' | 'incomplete'
  readonly stopReason: 'neighbors-exhausted' | 'depth-limit' | 'hop-budget' | 'budget-exhausted'
  readonly interpretation: 'source-asserted-relations'
  readonly conflictCheck: GraphConflictAudit['status']
  readonly conflictAudit: GraphConflictAudit
  readonly causalAlternatives: readonly GraphCausalAlternativeCheck[]
  /** Traversal claims and fully hydrated opposing claims; audit-only claims have no traversal path. */
  readonly claims: readonly { readonly record: GraphClaimRecord; readonly canonicalText: string }[]
  readonly relations: readonly GraphRelationRecord[]
  readonly sources: readonly GraphSourceContent[]
  /** Original from/to direction is preserved even when traversal is inverse. */
  readonly groups: readonly {
    readonly relation: GraphRelationRecord['ref']
    readonly from: GraphClaimRef
    readonly to: GraphClaimRef
  }[]
  /** Actual neighbor scans, including filtered edges; not a fabricated full recall trace. */
  readonly scannedEdges: number
  /** A predecessor forest, not every possible path and not a logical proof. */
  readonly pathPolicy: 'one-shortest-path-per-root-and-claim'
  readonly paths: readonly GraphTraversalPath[]
  /** Nodes at maxHops are retained but their adjacency is deliberately not read. */
  readonly depthFrontier: readonly { readonly root: GraphClaimRef; readonly node: GraphClaimRef }[]
  readonly traversalTrace: readonly {
    readonly root: GraphClaimRef
    readonly from: GraphClaimRef
    readonly to: GraphClaimRef
    readonly relation: GraphRelationRecord['ref']
    readonly depth: number
    readonly action: 'discovered' | 'cycle-skipped' | 'revisit-skipped'
  }[]
  readonly seedProgress: readonly { readonly seed: GraphClaimRef; readonly completion: 'complete' | 'incomplete' | 'not-started' }[]
}

export interface GraphTraversalPath {
  readonly root: GraphClaimRef
  readonly target: GraphClaimRef
  readonly depth: number
  /** null only for the root; otherwise points to a path entry with this same root. */
  readonly parent: GraphClaimRef | null
  readonly via: GraphRelationRecord['ref'] | null
}

export interface GraphRecallPorts {
  readonly readPort: GraphReadPort
  readonly evidenceReader: GraphEvidenceReader
  readonly seedPort?: GraphSeedPort
}

/** Shared orchestration. Public wrappers choose one hop or the caller's bounded depth. */
export function createGraphRecallService<Mode extends 'one-hop' | 'bounded'>(ports: GraphRecallPorts, mode: Mode) {
  type Depth = Mode extends 'one-hop' ? 1 : number
  return { async recall(input: GraphTraversalRecallRequest): Promise<GraphResult<GraphTraversalRecallResult<Depth>>> {
    let view: GraphReadView | undefined
    let result: GraphResult<GraphTraversalRecallResult<Depth>>
    try {
      const request = structuredClone(input)
      if (!request.recallId.trim() || request.seed.kind !== 'claim' || !request.seed.id.trim()
        || !Number.isSafeInteger(request.seed.version) || request.seed.version < 1
        || !['in', 'out', 'both'].includes(request.direction) || request.kinds.length === 0
        || request.kinds.some(kind => !RECALL_RELATION_KINDS.includes(kind)))
        fail('invalid-request', 'Invalid graph recall request')
      view = take(await ports.readPort.openView(request.view))
      if (view.manifest.manifestId !== request.view.expectedManifestId)
        fail('version-mismatch', 'Read view does not match the requested manifest')
      if (request.view.budget.maxSeeds < 1)
        fail('budget-exhausted', 'Graph recall needs one seed')
      result = { ok: true, value: await collect(view, request) }
    }
    catch (error) { result = errorResult(error, mode) }
    finally {
      if (view) {
        try { await view.close() }
        catch { result = { ok: false, error: { code: 'not-ready', message: 'Read view cleanup failed' } } }
      }
    }
    return result!
  }, async recallQuery(input: QueryGraphTraversalRecallRequest): Promise<GraphResult<QueryGraphTraversalRecallResult<Depth>>> {
    let view: GraphReadView | undefined
    let result: GraphResult<QueryGraphTraversalRecallResult<Depth>>
    try {
      const request = structuredClone(input)
      if (!ports.seedPort) fail('unsupported-capability', 'A seed search adapter is required')
      if (!request.recallId.trim() || !request.query.trim() || request.query.length > 2000)
        fail('invalid-request', 'Query recall needs an ID and 1 to 2000 query characters')
      const queryPlan = take(planGraphQuery({ query: request.query, relationModel: request.view.expectedRelationManifestId ? 'l2' : undefined, temporal: request.view.temporal,
        timePlanning: request.timePlanning, constraints: request.constraints, direction: request.direction, kinds: request.kinds }))
      const timePlan = queryPlan.timePlan
      if (queryPlan.status === 'needs-clarification' || !queryPlan.traversal) {
        return { ok: true, value: { recallId: request.recallId, timePlan, queryPlan,
          status: 'needs-clarification', selection: 'top-k', seeds: { items: [], scanned: 0, completion: 'complete' }, recall: null } }
      }
      Object.assign(request, { query: queryPlan.searchQuery, view: { ...request.view, temporal: queryPlan.temporal } })
      const { direction, kinds } = queryPlan.traversal
      // Search and expansion share this single view; no reset of time, nodes,
      // seed count or evidence budget between the two stages.
      view = take(await ports.readPort.openView(request.view))
      if (view.manifest.manifestId !== request.view.expectedManifestId)
        fail('version-mismatch', 'Read view does not match the requested manifest')
      const page = take(await ports.seedPort.search({
        protocolVersion: MEMORY_GRAPH_PROTOCOL_VERSION, recallId: request.recallId,
        query: request.query, mode: 'direct-only', scope: request.view.access.scope,
        temporal: request.view.temporal, budget: request.view.budget,
        sharePolicies: request.view.access.sharePolicies, sensitivities: request.view.access.sensitivities,
        expectedManifestId: request.view.expectedManifestId,
        entities: queryPlan.target.entities,
        entries: request.seedEntries,
        traversal: queryPlan.traversal,
      }, view))
      if (!Number.isSafeInteger(page.scanned) || page.scanned < 0 || page.items.length > request.view.budget.maxSeeds
        || new Set(page.items.map(item => refKey(item.ref))).size !== page.items.length
        || page.items.some((item, index) => item.ref.kind !== 'claim' || !Number.isFinite(item.relevance)
          || item.relevance < 0 || item.relevance > 1 || (index > 0 && item.relevance > page.items[index - 1]!.relevance)))
        fail('invalid-request', 'Seed reader returned invalid or unsorted candidates')
      const seeds = page as QueryGraphTraversalRecallResult['seeds']
      const first = seeds.items[0]
      // An incomplete candidate ranking is never used to declare a winning seed.
      if (page.completion !== 'complete') {
        result = { ok: true, value: { recallId: request.recallId, timePlan, queryPlan, status: 'seed-search-incomplete', selection: 'top-k', seeds, recall: null } }
      }
      else if (!first) {
        result = { ok: true, value: { recallId: request.recallId, timePlan, queryPlan, status: 'no-match', selection: 'top-k', seeds, recall: null } }
      }
      else {
        const recall = await collect(view, {
          recallId: request.recallId, view: request.view, seed: first.ref,
          direction, kinds,
        }, seeds.items.map(item => item.ref))
        result = { ok: true, value: { recallId: request.recallId, timePlan, queryPlan, status: 'recalled', selection: 'top-k', seeds, recall } }
      }
    }
    catch (error) { result = errorResult(error, mode) }
    finally {
      if (view) {
        try { await view.close() }
        catch { result = { ok: false, error: { code: 'not-ready', message: 'Read view cleanup failed' } } }
      }
    }
    return result!
  } }

  async function collect(view: GraphReadView, request: GraphTraversalRecallRequest, roots: readonly GraphClaimRef[] = [request.seed]): Promise<GraphTraversalRecallResult<Depth>> {
    const claims = new Map<string, { record: GraphClaimRecord; canonicalText: string }>()
    const facts = new Map<string, string>()
    const sources = new Map<string, GraphSourceContent>()
    const relations = new Map<string, GraphRelationRecord>()
    const kinds = [...new Set(request.kinds)]
    const maxHops = (mode === 'one-hop' ? 1 : request.view.budget.maxHops) as Depth
    const paths: GraphTraversalPath[] = []
    const startedExpansions = new Set<string>()
    const completedExpansions = new Set<string>()
    const depthFrontier: { root: GraphClaimRef; node: GraphClaimRef }[] = []
    const traversalTrace: Array<GraphTraversalRecallResult['traversalTrace'][number]> = []
    let scannedEdges = 0
    let stopReason: GraphTraversalRecallResult['stopReason'] = 'neighbors-exhausted'
    const seedProgress = roots.map(seed => ({ seed, completion: 'not-started' as 'complete' | 'incomplete' | 'not-started' }))

    // Stage a whole group before publishing it. Failed hydration must not leave
    // an orphan endpoint or a relation without its evidence in the result.
    async function hydrate(refs: readonly GraphClaimRef[], relation?: GraphRelationRecord): Promise<void> {
      const needed = unique(refs, refKey).filter(ref => !claims.has(refKey(ref)))
      const records = exact(needed, take(await view.resolveClaims(needed)), refKey, item => refKey(item.ref))
      const missingFacts = unique(records.map(record => record.fact), refKey).filter(ref => !facts.has(refKey(ref)))
      const loadedFacts = missingFacts.length === 0 ? [] : exact(missingFacts,
        take(await ports.evidenceReader.resolveFactVersions(view, missingFacts)), refKey, item => refKey(item.ref))
      const stagedFacts = new Map(loadedFacts.map(item => [refKey(item.ref), item.canonicalText]))
      const sourceRefs = unique([
        ...records.flatMap(record => record.evidence.map(item => item.source)),
        ...relation?.evidence.map(item => item.source) ?? [],
      ], sourceKey).filter(ref => !sources.has(sourceKey(ref)))
      const loadedSources = sourceRefs.length === 0 ? [] : exact(sourceRefs,
        take(await ports.evidenceReader.readSources(view, sourceRefs)), sourceKey, item => sourceKey(item.ref))
      for (const record of records) {
        const canonicalText = stagedFacts.get(refKey(record.fact)) ?? facts.get(refKey(record.fact))
        if (canonicalText === undefined) fail('source-unavailable', 'Exact fact text is unavailable')
        claims.set(refKey(record.ref), { record, canonicalText })
      }
      stagedFacts.forEach((text, key) => facts.set(key, text))
      loadedSources.forEach(item => sources.set(sourceKey(item.ref), item))
      if (relation) relations.set(refKey(relation.ref), relation)
    }

    for (const progress of seedProgress) {
      const seed = progress.seed
      progress.completion = 'incomplete'
      try { await hydrate([seed]) }
      catch (error) {
        // Preserve earlier complete groups if a later root cannot fit. Failure
        // to hydrate the very first root still returns an explicit error.
        if (!(error instanceof ReadFailure) || error.detail.code !== 'budget-exhausted' || claims.size === 0) throw error
        stopReason = 'budget-exhausted'
        break
      }
      const rootPath: GraphTraversalPath = { root: seed, target: seed, depth: 0, parent: null, via: null }
      const visited = new Map<string, GraphTraversalPath>([[refKey(seed), rootPath]])
      const queue = [rootPath]
      paths.push(rootPath)
      if (maxHops === 0) depthFrontier.push({ root: seed, node: seed })
      if (mode === 'one-hop' && request.view.budget.maxHops === 0) { stopReason = 'hop-budget'; continue }
      // Breadth first within each ranked root. Evidence is shared globally, but
      // reachability/depth is root-local: an earlier root must not hide a later path.
      for (let head = 0; head < queue.length; head++) {
        const current = queue[head]!
        if (current.depth >= maxHops) {
          continue
        }
        startedExpansions.add(refKey(current.target))
        let cursor: string | undefined
        const cursors = new Set<string>()
        while (true) {
          const read = await view.neighbors({
            node: current.target, layer: 'semantic', direction: request.direction, kinds,
            limit: 1, maxScanned: 64, ...(cursor === undefined ? {} : { cursor }),
          })
          if (!read.ok && read.error.code === 'budget-exhausted') { stopReason = 'budget-exhausted'; break }
          const page = take(read)
          if (!Number.isSafeInteger(page.scanned) || page.scanned < 0 || page.scanned > 64
            || page.items.length > 1 || page.items.length > page.scanned)
            fail('invalid-request', 'Neighbor reader returned an invalid page')
          scannedEdges += page.scanned
          if (scannedEdges > request.view.budget.maxEdges)
            fail('budget-exhausted', 'Neighbor reader exceeded the shared edge budget')
          let hydrationStopped = false
          for (const edge of page.items) {
            if (edge.layer !== 'semantic' || !('relationRef' in edge) || !kinds.includes(edge.kind)
              || !incident(edge.from, edge.to, current.target, edge.kind === 'contradicts' ? 'both' : request.direction))
              fail('invalid-request', 'Neighbor edge does not match the requested relation query')
            try {
              // Validate projection consistency even if another root already hydrated this relation.
              const relation = relations.get(refKey(edge.relationRef)) ?? exact([edge.relationRef],
                take(await view.resolveRelations([edge.relationRef])), refKey, item => refKey(item.ref))[0]!
              if (relation.kind !== edge.kind || refKey(relation.from) !== refKey(edge.from)
                || refKey(relation.to) !== refKey(edge.to))
                fail('version-mismatch', 'Relation record does not match its projection edge')
              if (!relations.has(refKey(relation.ref))) await hydrate([relation.from, relation.to], relation)
              const next = refKey(current.target) === refKey(relation.from) ? relation.to : relation.from
              let action: GraphTraversalRecallResult['traversalTrace'][number]['action'] = 'discovered'
              if (visited.has(refKey(next))) {
                action = 'revisit-skipped'
                let ancestor: GraphTraversalPath | undefined = current
                while (ancestor) {
                  if (refKey(ancestor.target) === refKey(next)) { action = 'cycle-skipped'; break }
                  ancestor = ancestor.parent ? visited.get(refKey(ancestor.parent)) : undefined
                }
              }
              else {
                const path: GraphTraversalPath = { root: seed, target: next, depth: current.depth + 1,
                  parent: current.target, via: relation.ref }
                visited.set(refKey(next), path)
                queue.push(path)
                paths.push(path)
                if (path.depth === maxHops) depthFrontier.push({ root: seed, node: next })
              }
              // Traversal orientation is separate from the stored relation's original from/to.
              traversalTrace.push({ root: seed, from: current.target, to: next, relation: relation.ref,
                depth: current.depth + 1, action })
            }
            catch (error) {
              if (!(error instanceof ReadFailure) || error.detail.code !== 'budget-exhausted') throw error
              stopReason = 'budget-exhausted'
              hydrationStopped = true
              break
            }
          }
          if (hydrationStopped) break
          if (page.completion === 'budget-exhausted') { stopReason = 'budget-exhausted'; break }
          if (page.completion === 'complete') { completedExpansions.add(refKey(current.target)); break }
          if (page.scanned === 0 || !page.nextCursor || cursors.has(page.nextCursor))
            fail('invalid-request', 'Neighbor pagination did not make progress')
          cursors.add(page.nextCursor)
          cursor = page.nextCursor
        }
        if (stopReason === 'budget-exhausted') break
      }
      if (stopReason === 'budget-exhausted') break
      progress.completion = 'complete'
    }
    if (mode === 'bounded' && stopReason === 'neighbors-exhausted' && depthFrontier.length > 0)
      stopReason = 'depth-limit'

    // Audit a fixed set: opposing evidence must not recursively grow the traversal.
    const traversalClaims = [...claims.values()].map(item => item.record)
    const conflictAudit = mode === 'one-hop' ? unperformedConflictAudit()
      : take(await checkClaimConflicts(view, traversalClaims, request.view.temporal, async ref => {
        try {
          await hydrate([ref])
          return { ok: true, value: claims.get(refKey(ref))!.record }
        }
        catch (error) { return errorResult(error, mode) }
      }))
    const causalAlternatives = mode === 'one-hop' ? [] : summarizeCausalAlternatives(
      traversalClaims, [...relations.values()], request.direction, kinds, startedExpansions, completedExpansions)

    const raw: GraphTraversalRecallData<Depth> = structuredClone({
      recallId: request.recallId, manifestId: view.manifest.manifestId, relationManifest: view.relationManifest,
      policyVersion: request.view.policyVersion, scope: request.view.access.scope, temporal: request.view.temporal,
      searchScope: { seed: request.seed, seeds: roots, direction: request.direction, kinds, maxHops },
      completeness: (stopReason === 'neighbors-exhausted' || stopReason === 'depth-limit') ? 'complete-within-declared-scope' : 'incomplete',
      stopReason, interpretation: 'source-asserted-relations', conflictCheck: conflictAudit.status, conflictAudit, causalAlternatives,
      claims: [...claims.values()], relations: [...relations.values()], sources: [...sources.values()],
      groups: [...relations.values()].map(relation => ({ relation: relation.ref, from: relation.from, to: relation.to })),
      scannedEdges, seedProgress, pathPolicy: 'one-shortest-path-per-root-and-claim', paths, depthFrontier, traversalTrace,
    })
    const evidencePack = take(buildGraphAnswerEvidence(raw))
    // Cached text is returned only after rechecking current authorization,
    // source availability and relation eligibility. On timeout/revocation this
    // fails closed instead of leaking earlier cached evidence as partial success.
    const claimRefs = [...claims.values()].map(item => item.record.ref)
    exact(claimRefs, take(await view.resolveClaims(claimRefs)), refKey, item => refKey(item.ref))
    const relationRefs = [...relations.values()].map(item => item.ref)
    exact(relationRefs, take(await view.resolveRelations(relationRefs)), refKey, item => refKey(item.ref))
    return { ...raw, evidencePack }
  }
}

class ReadFailure extends Error {
  constructor(readonly detail: GraphProtocolError) { super(detail.message) }
}
function fail(code: GraphProtocolError['code'], message: string): never { throw new ReadFailure({ code, message }) }
function take<T>(result: GraphResult<T>): T {
  if (!result.ok) throw new ReadFailure(result.error)
  return result.value
}
function errorResult(error: unknown, mode: 'one-hop' | 'bounded'): { ok: false; error: GraphProtocolError } {
  return { ok: false, error: error instanceof ReadFailure ? error.detail
    : { code: 'not-ready', message: mode === 'one-hop' ? 'One-hop graph reader failed' : 'Graph recall reader failed' } }
}
function exact<R, T>(refs: readonly R[], items: readonly T[], refId: (ref: R) => string, itemId: (item: T) => string): T[] {
  const indexed = new Map(items.map(item => [itemId(item), item]))
  if (indexed.size !== refs.length || items.length !== refs.length || refs.some(ref => !indexed.has(refId(ref))))
    fail('source-unavailable', 'Reader did not return all requested exact versions')
  return refs.map(ref => indexed.get(refId(ref))!)
}
function unique<T>(items: readonly T[], key: (item: T) => string): T[] {
  return [...new Map(items.map(item => [key(item), item])).values()]
}
function refKey(ref: GraphVersionRef<string>): string { return JSON.stringify([ref.kind, ref.id, ref.version]) }
function sourceKey(ref: GraphSourceRef): string {
  return JSON.stringify([ref.episodeId, ref.contentHash, ref.locator.kind,
    ...(ref.locator.kind === 'text-span' ? [ref.locator.unit, ref.locator.start, ref.locator.end] : [])])
}
function incident(from: GraphClaimRef, to: GraphClaimRef, seed: GraphClaimRef, direction: GraphNeighborQuery['direction']): boolean {
  return (direction !== 'in' && refKey(from) === refKey(seed)) || (direction !== 'out' && refKey(to) === refKey(seed))
}
