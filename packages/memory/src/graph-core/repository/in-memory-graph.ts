import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { MEMORY_GRAPH_PROTOCOL_VERSION } from '@continuum-memory/contracts'
import type {
  GraphClaimRef, GraphProtocolErrorCode, GraphResult, GraphScope,
  GraphSourceRef, GraphTemporalQuery, GraphTimeExtent, GraphVersionRef,
} from '@continuum-memory/contracts'
import type {
  GraphClaimRecord, GraphProjectionManifest,
   GraphSemanticRecord,
} from '../domain/types'
import type { GraphRecallRelationKind as GraphRelationKind, GraphRecallRelationRecord as GraphRelationRecord } from '../domain/recall-types'
import { areOppositeClaims, claimConflictKey, EXACT_CONFLICT_POLICY } from '../domain/claim-conflicts'
import { validateGraphRelations } from '../domain/validation'
import type { GraphRelationValidationInput } from '../domain/validation'
import { createRelationAdjacencyIndex } from '../projection/adjacency-index'
import { matchesGraphSeedQuery, prepareGraphLexicalQuery, rankGraphLexicalSeeds } from '../recall/lexical-seeds'
import type {
  GraphAccessContext, GraphRecallEvidenceReader as GraphEvidenceReader, GraphRecallNeighborQuery as GraphNeighborQuery, GraphRecallOpenViewRequest as GraphOpenViewRequest,
  GraphPage, GraphPageRequest, GraphRecallReadPort as GraphReadPort, GraphRecallReadView as GraphReadView, GraphRecallSeedPort as GraphSeedPort, GraphSeedCandidate, GraphSeedOrigin,
} from '../ports/graph-recall-ports'
import type { GraphRecallRelationEdge as GraphRelationEdge } from '../domain/recall-types'

export interface InMemoryGraphOptions {
  readonly data: GraphRelationValidationInput
  readonly manifest: GraphProjectionManifest
  /** Trusted host lookup, rechecked on EVERY operation. Caller objects are not grants. */
  readonly resolveAccess: (accessContextId: string) => GraphAccessContext | undefined
  /** Actual tokenizer supplied by the host; never approximate tokens with characters. */
  readonly countTokens: (text: string) => number
  /** Monotonic elapsed-time clock, unrelated to the query's valid/knownAt clocks. */
  readonly clock?: () => number
  /** Cumulative Claim scans plus explicit relation-entry lookups per view. */
  readonly maxSeedScanned?: number
  /** Cumulative exact-key conflict candidates scanned across all targets/pages in one view. */
  readonly maxConflictScanned?: number
}

export interface InMemoryGraph extends GraphReadPort {
  readonly evidenceReader: GraphEvidenceReader
  readonly seedPort: GraphSeedPort
  /** Returns a detached manifest so a host can obtain expectedManifestId. */
  manifest: () => GraphProjectionManifest
  /** Host lifecycle action: old views stop serving this projection immediately. */
  invalidate: () => void
  /** Current deletion blocks even historical reads of every version of an episode. */
  revokeSource: (episodeId: string) => void
}

/**
 * Immutable in-memory direct-relation reader, not a database or recall service.
 * Only accepted, asserted, unconditional Claims and supported explicit active
 * relations are served. Unknown valid time is excluded, not made unbounded.
 * Conflict lookup is restricted to exact opposite polarity; rules remain unsupported.
 */
export function createInMemoryGraph(options: InMemoryGraphOptions): InMemoryGraph {
  const maxSeedScanned = options.maxSeedScanned ?? 10000
  if (!Number.isSafeInteger(maxSeedScanned) || maxSeedScanned < 1 || maxSeedScanned > 10000)
    throw new Error('maxSeedScanned must be an integer between 1 and 10000')
  const maxConflictScanned = options.maxConflictScanned ?? 10000
  if (!Number.isSafeInteger(maxConflictScanned) || maxConflictScanned < 1 || maxConflictScanned > 10000)
    throw new Error('maxConflictScanned must be an integer between 1 and 10000')
  const data = structuredClone(options.data)
  const manifest = structuredClone(options.manifest)
  const validation = validateGraphRelations(data)
  if (!validation.ok)
    throw new Error(`Invalid graph relation data: ${validation.issues[0]!.code} at ${validation.issues[0]!.path}`)
  if (manifest.protocolVersion !== MEMORY_GRAPH_PROTOCOL_VERSION || manifest.schemaVersion !== data.bundle.schemaVersion
    || !manifest.manifestId.trim() || !manifest.semanticFingerprint.trim() || !manifest.builderVersion.trim()
    || manifest.sourceBundleId !== data.bundle.bundleId || !sameScope(manifest.scope, data.bundle.scope)
    || Object.keys(manifest.sourceRevisions).some(key =>
      manifest.sourceRevisions[key as keyof typeof manifest.sourceRevisions] !== data.bundle.revisions[key as keyof typeof data.bundle.revisions]))
    throw new Error('Manifest does not identify the supplied semantic bundle and revisions')
  // Ambiguous transaction histories must not revive an older active relation.
  for (const records of [data.bundle.claims, data.bundle.relations]) {
    const groups = new Map<string, typeof records[number][]>()
    for (const record of records) {
      const id = JSON.stringify([record.ref.kind, record.ref.id])
      groups.set(id, [...groups.get(id) ?? [], record])
    }
    for (const group of groups.values()) {
      group.sort((a, b) => a.transactionTime.recordedAt - b.transactionTime.recordedAt || a.ref.version - b.ref.version)
      for (let i = 1; i < group.length; i++) {
        const previous = group[i - 1]!
        const current = group[i]!
        if (previous.transactionTime.closedAt === null
          || previous.transactionTime.closedAt > current.transactionTime.recordedAt
          || previous.ref.version >= current.ref.version)
          throw new Error('Overlapping or unordered record transaction versions')
      }
    }
  }

  const claims = new Map(data.bundle.claims.map(item => [refKey(item.ref), item]))
  const conflictIndex = new Map<string, GraphClaimRecord[]>()
  for (const claim of data.bundle.claims) {
    const key = claimConflictKey(claim)
    const bucket = conflictIndex.get(key) ?? []
    bucket.push(claim)
    conflictIndex.set(key, bucket)
  }
  for (const bucket of conflictIndex.values()) bucket.sort((a, b) => refKey(a.ref).localeCompare(refKey(b.ref)))
  const entityClaims = new Map<string, Set<string>>()
  for (const claim of data.bundle.claims) {
    for (const term of Object.values(claim.atom.args)) {
      if (term.kind !== 'entity') continue
      const key = refKey(term.ref)
      const linked = entityClaims.get(key) ?? new Set<string>()
      linked.add(refKey(claim.ref))
      entityClaims.set(key, linked)
    }
  }
  const relations = new Map(data.bundle.relations.map(item => [refKey(item.ref), item]))
  const contexts = new Map(data.bundle.contexts.map(item => [refKey(item.ref), item]))
  const entities = new Map(data.bundle.entities.map(item => [refKey(item.ref), item]))
  const facts = new Map(data.factVersions.map(item => [refKey(item.ref), item]))
  const sources = new Map(data.sources.map(item => [sourceKey(item), item]))
  const sourceOwners = new Map<string, Array<GraphClaimRecord | GraphRelationRecord>>()
  const factClaims = new Map<string, GraphClaimRecord[]>()
  for (const record of [...data.bundle.claims, ...data.bundle.relations]) {
    for (const entry of record.evidence) {
      const key = sourceRefKey(entry.source)
      sourceOwners.set(key, [...sourceOwners.get(key) ?? [], record])
    }
    if ('fact' in record) {
      const key = refKey(record.fact)
      factClaims.set(key, [...factClaims.get(key) ?? [], record])
    }
  }
  const index = createRelationAdjacencyIndex(data.edges)
  const tombstones = new Set<string>()
  const clock = options.clock ?? (() => performance.now())
  let stale = manifest.state === 'stale'
  // Object identity prevents callers from forging a viewId to bypass its policy.
  const readers = new WeakMap<GraphReadView, GraphEvidenceReader>()
  const seedReaders = new WeakMap<GraphReadView, GraphSeedPort>()

  function open(request: GraphOpenViewRequest): GraphResult<GraphReadView> {
    const context = structuredClone(request)
    if (!validRequest(context))
      return failure('invalid-request', 'Invalid scope, temporal query, policy or budget')
    if (context.expectedManifestId !== manifest.manifestId)
      return failure('version-mismatch', 'Requested manifest is not available')
    if (stale)
      return failure('stale-projection', 'Projection has been invalidated')
    if (manifest.state !== 'ready')
      return failure('not-ready', 'Projection is not ready')
    let closed = false
    const startedAt = clock()
    const visited = new Set<string>()
    let scannedEdges = 0
    let evidenceTokens = 0
    let seedScanned = 0
    let conflictScanned = 0
    const selectedSeeds = new Set<string>()
    const cursors = new Map<string, { fingerprint: string; position: number }>()
    const viewId = randomUUID()

    function access(): GraphResult<GraphAccessContext> {
      if (closed)
        return failure('view-closed', 'Read view is closed')
      if (stale)
        return failure('stale-projection', 'Projection has been invalidated')
      let grant: GraphAccessContext | undefined
      try { grant = options.resolveAccess(context.access.accessContextId) }
      catch { return failure('scope-denied', 'Host authorization is unavailable') }
      if (!grant || grant.accessContextId !== context.access.accessContextId
        || grant.authorizationVersion !== context.access.authorizationVersion
        || !scopeContains(grant.scope, context.access.scope)
        || !scopeContains(manifest.scope, context.access.scope))
        return failure('scope-denied', 'Read view is not authorized')
      if (clock() - startedAt >= context.budget.maxElapsedMs)
        return failure('budget-exhausted', 'Elapsed-time budget exhausted')
      return success({
        ...structuredClone(grant), scope: context.access.scope,
        sharePolicies: context.access.sharePolicies.filter(value => grant!.sharePolicies.includes(value)),
        sensitivities: context.access.sensitivities.filter(value => grant!.sensitivities.includes(value)),
      })
    }

    const authorized = access()
    if (!authorized.ok)
      return authorized

    function sourceAllowed(ref: GraphSourceRef, grant: GraphAccessContext): boolean {
      const source = sources.get(sourceKey(ref))
      if (!source || tombstones.has(ref.episodeId) || !scopesIntersect(source.scope, grant.scope))
        return false
      const span = ref.locator
      if (span.kind === 'whole-content')
        return true
      if (span.kind !== 'text-span' || span.unit !== 'utf16' || !Number.isSafeInteger(span.start)
        || !Number.isSafeInteger(span.end) || span.start < 0 || span.start >= span.end || span.end > source.content.length)
        return false
      return ![span.start, span.end].some(offset => {
        const a = source.content.charCodeAt(offset - 1)
        const b = source.content.charCodeAt(offset)
        return a >= 0xD800 && a <= 0xDBFF && b >= 0xDC00 && b <= 0xDFFF
      })
    }

    function recordAllowed(record: GraphSemanticRecord, grant: GraphAccessContext): boolean {
      const tx = record.transactionTime
      return scopesIntersect(record.scope, grant.scope)
        && grant.sharePolicies.includes(record.sharePolicy) && grant.sensitivities.includes(record.sensitivity)
        && record.review.status === 'accepted' && record.review.reviewedAt <= context.temporal.knownAt
        && tx.recordedAt <= context.temporal.knownAt
        && (tx.closedAt === null || context.temporal.knownAt < tx.closedAt)
        && record.provenance.sources.every(ref => sourceAllowed(ref, grant))
    }

    function contextAllowed(record: GraphClaimRecord | GraphRelationRecord, grant: GraphAccessContext): boolean {
      const ctx = contexts.get(refKey(record.context))
      return !!ctx && ctx.scenario === 'actual' && recordAllowed(ctx, grant)
    }

    function claimAllowed(claim: GraphClaimRecord, grant: GraphAccessContext): boolean {
      return recordAllowed(claim, grant) && contextAllowed(claim, grant)
        && timeMatches(claim.validTime, context.temporal)
        && claim.modality === 'asserted' && claim.condition.kind === 'none'
        && (claim.polarity === 'positive' || claim.polarity === 'negative')
        && claim.evidence.some(entry => entry.role === 'supports' && entry.strength === 'direct')
        && claim.evidence.every(entry => sourceAllowed(entry.source, grant))
        && Object.values(claim.atom.args).every(term => {
          if (term.kind !== 'entity') return true
          const entity = entities.get(refKey(term.ref))
          return !!entity && recordAllowed(entity, grant)
        })
    }

    function relationAllowed(relation: GraphRelationRecord, grant: GraphAccessContext): boolean {
      const from = claims.get(refKey(relation.from))
      const to = claims.get(refKey(relation.to))
      return recordAllowed(relation, grant) && contextAllowed(relation, grant)
        && timeMatches(relation.validTime, context.temporal)
        && relation.status === 'active' && relation.assertion === 'explicit-claim' && relation.support === 'supported'
        && relation.evidence.every(entry => sourceAllowed(entry.source, grant))
        && !!from && !!to && claimAllowed(from, grant) && claimAllowed(to, grant)
    }

    function visit(refs: readonly GraphClaimRef[]): boolean {
      const keys = refs.map(refKey)
      const next = new Set([...visited, ...keys])
      if (next.size > context.budget.maxNodes)
        return false
      keys.forEach(key => visited.add(key))
      return true
    }

    function chargeEvidence(texts: readonly string[]): GraphResult<true> {
      let cost = 0
      try {
        for (const text of texts) {
          const count = options.countTokens(text)
          if (!Number.isSafeInteger(count) || count < 0 || (text.length > 0 && count === 0))
            return failure('invalid-request', 'Host tokenizer returned an invalid token count')
          cost += count
        }
      }
      catch { return failure('not-ready', 'Host tokenizer is unavailable') }
      if (evidenceTokens + cost > context.budget.maxEvidenceTokens)
        return failure('budget-exhausted', 'Evidence token budget exhausted')
      evidenceTokens += cost
      return success(true)
    }

    async function neighbors(query: GraphNeighborQuery): Promise<GraphResult<GraphPage<GraphRelationEdge>>> {
      const auth = access()
      if (!auth.ok) return auth
      if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 1000
        || !Number.isSafeInteger(query.maxScanned) || query.maxScanned < 1 || query.maxScanned > 10000
        || !['in', 'out', 'both'].includes(query.direction))
        return failure('invalid-request', 'Invalid neighbor page request')
      if (query.node.kind !== 'claim' || query.layer !== 'semantic'
        || query.kinds.some(kind => !['causal', 'contributes-to', 'before'].includes(kind)))
        return failure('unsupported-capability', 'Only direct Claim relation edges are supported')
      const origin = claims.get(refKey(query.node))
      if (!origin || !claimAllowed(origin, auth.value))
        return failure('source-unavailable', 'Requested claim is unavailable in this view')
      if (!visit([origin.ref]))
        return success({ items: [], scanned: 0, completion: 'budget-exhausted' })
      const fingerprint = JSON.stringify([refKey(query.node), query.layer, query.direction, [...new Set(query.kinds)].sort()])
      const cursor = query.cursor === undefined ? undefined : cursors.get(query.cursor)
      if (query.cursor !== undefined && (!cursor || cursor.fingerprint !== fingerprint))
        return failure('invalid-request', 'Cursor does not belong to this view and query')
      const candidates = index.candidates(query.node, query.direction, query.kinds as GraphRelationKind[])
      let position = cursor?.position ?? 0
      let scanned = 0
      const items: GraphRelationEdge[] = []
      let exhausted = false
      while (position < candidates.length && items.length < query.limit && scanned < query.maxScanned) {
        const fresh = access()
        if (!fresh.ok) {
          if (fresh.error.code !== 'budget-exhausted') return fresh
          exhausted = true
          break
        }
        if (scannedEdges >= context.budget.maxEdges || context.budget.maxHops === 0) {
          exhausted = true
          break
        }
        const edge = candidates[position]!
        scanned += 1
        scannedEdges += 1
        const relation = relations.get(refKey(edge.relationRef))!
        if (relationAllowed(relation, fresh.value)) {
          if (!visit([edge.from, edge.to])) {
            exhausted = true
            break
          }
          items.push(edge)
        }
        position += 1
      }
      if (position >= candidates.length)
        return success({ items, scanned, completion: 'complete' })
      if (exhausted || scannedEdges >= context.budget.maxEdges)
        return success({ items, scanned, completion: 'budget-exhausted' })
      const nextCursor = randomUUID()
      cursors.set(nextCursor, { fingerprint, position })
      return success({ items, scanned, completion: 'more', nextCursor })
    }

    async function findConflicts(ref: GraphClaimRef, page: GraphPageRequest): Promise<GraphResult<GraphPage<GraphClaimRecord>>> {
      const auth = access()
      if (!auth.ok) return auth
      if (!Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 1000
        || !Number.isSafeInteger(page.maxScanned) || page.maxScanned < 1 || page.maxScanned > 10000)
        return failure('invalid-request', 'Invalid conflict page request')
      const target = claims.get(refKey(ref))
      if (!target || !claimAllowed(target, auth.value))
        return failure('source-unavailable', 'Conflict target is unavailable in this view')
      const fingerprint = JSON.stringify(['conflicts', EXACT_CONFLICT_POLICY, refKey(ref)])
      const cursor = page.cursor === undefined ? undefined : cursors.get(page.cursor)
      if (page.cursor !== undefined && (!cursor || cursor.fingerprint !== fingerprint))
        return failure('invalid-request', 'Conflict cursor does not belong to this view and target')
      if (!visit([target.ref])) return success({ items: [], scanned: 0, completion: 'budget-exhausted' })
      const candidates = conflictIndex.get(claimConflictKey(target)) ?? []
      let position = cursor?.position ?? 0
      let scanned = 0
      let exhausted = false
      const items: GraphClaimRecord[] = []
      while (position < candidates.length && items.length < page.limit && scanned < page.maxScanned) {
        const fresh = access()
        if (!fresh.ok) return fresh
        if (conflictScanned >= maxConflictScanned) { exhausted = true; break }
        const candidate = candidates[position]!
        scanned++
        conflictScanned++
        if (claimAllowed(candidate, fresh.value) && areOppositeClaims(target, candidate, context.temporal)) {
          if (!visit([candidate.ref])) { exhausted = true; break }
          items.push(candidate)
        }
        position++
      }
      const end = access()
      if (!end.ok) return end
      if (!claimAllowed(target, end.value) || items.some(item => !claimAllowed(item, end.value)))
        return failure('source-unavailable', 'Conflict evidence became unavailable')
      const detached = structuredClone(items)
      if (position >= candidates.length) return success({ items: detached, scanned, completion: 'complete' })
      if (exhausted || conflictScanned >= maxConflictScanned)
        return success({ items: detached, scanned, completion: 'budget-exhausted' })
      const nextCursor = randomUUID()
      cursors.set(nextCursor, { fingerprint, position })
      return success({ items: detached, scanned, completion: 'more', nextCursor })
    }

    const view: GraphReadView = {
      viewId, manifest: structuredClone(manifest), context: structuredClone(context),
      async resolveClaims(refs) {
        const auth = access()
        if (!auth.ok) return auth
        const items: GraphClaimRecord[] = []
        for (const ref of refs) {
          const claim = claims.get(refKey(ref))
          if (!claim || !claimAllowed(claim, auth.value))
            return failure('source-unavailable', 'An exact claim version is unavailable in this view')
          items.push(claim)
        }
        if (!visit(items.map(item => item.ref)))
          return failure('budget-exhausted', 'Node budget exhausted')
        const end = access()
        return end.ok ? success(structuredClone(items)) : end
      },
      async resolveRelations(refs) {
        const auth = access()
        if (!auth.ok) return auth
        const items: GraphRelationRecord[] = []
        for (const ref of refs) {
          const relation = relations.get(refKey(ref))
          if (!relation || !relationAllowed(relation, auth.value))
            return failure('source-unavailable', 'An exact relation version is unavailable in this view')
          items.push(relation)
        }
        if (!visit(items.flatMap(item => [item.from, item.to])))
          return failure('budget-exhausted', 'Node budget exhausted')
        const end = access()
        return end.ok ? success(structuredClone(items)) : end
      },
      neighbors,
      async resolveStatements() { const auth = access(); return auth.ok ? failure('unsupported-capability', 'Statement reads are not implemented by the fixture reader') : auth },
      async resolveRules() { const auth = access(); return auth.ok ? failure('unsupported-logic', 'Rule reads are not implemented') : auth },
      async matchRuleBody() { const auth = access(); return auth.ok ? failure('unsupported-logic', 'Rule matching is not implemented') : auth },
      conflictPolicy: EXACT_CONFLICT_POLICY,
      findConflicts,
      async close() { closed = true; cursors.clear() },
    }

    // Only references reachable from eligible claims/relations may be read.
    // Scope alone must not allow arbitrary source IDs or wider source spans.
    readers.set(view, {
      async readSources(_view, refs) {
        const auth = access()
        if (!auth.ok) return auth
        const items = []
        for (const ref of refs) {
          // A shared span may belong to several claims. Prefer an eligible
          // owner already visited instead of charging an arbitrary extra node.
          const owners = (sourceOwners.get(sourceRefKey(ref)) ?? []).filter(record =>
            'fact' in record ? claimAllowed(record, auth.value) : relationAllowed(record, auth.value))
          const extraNodes = (record: GraphClaimRecord | GraphRelationRecord) =>
            new Set(('fact' in record ? [record.ref] : [record.from, record.to])
              .map(refKey).filter(key => !visited.has(key))).size
          const owner = owners.reduce<GraphClaimRecord | GraphRelationRecord | undefined>((best, record) =>
            !best || extraNodes(record) < extraNodes(best) ? record : best, undefined)
          if (!owner || !sourceAllowed(ref, auth.value))
            return failure('source-unavailable', 'An exact source reference is unavailable in this view')
          if (!visit('fact' in owner ? [owner.ref] : [owner.from, owner.to]))
            return failure('budget-exhausted', 'Node budget exhausted')
          const source = sources.get(sourceKey(ref))!
          // Return precisely the allowed span; never disclose the rest of an episode.
          const content = ref.locator.kind === 'whole-content' ? source.content
            : source.content.slice(ref.locator.start, ref.locator.end)
          items.push({ ref, content, scope: source.scope })
        }
        const budget = chargeEvidence(items.map(item => item.content))
        if (!budget.ok) return budget
        const end = access()
        return end.ok ? success(structuredClone(items)) : end
      },
      async resolveFactVersions(_view, refs) {
        const auth = access()
        if (!auth.ok) return auth
        const items = []
        const used: GraphClaimRef[] = []
        for (const ref of refs) {
          const fact = facts.get(refKey(ref))
          const mapped = (factClaims.get(refKey(ref)) ?? []).filter(claim => claimAllowed(claim, auth.value))
          if (!fact || mapped.length === 0 || !scopesIntersect(fact.scope, auth.value.scope))
            return failure('source-unavailable', 'An exact fact version is unavailable in this view')
          used.push(...mapped.map(claim => claim.ref))
          items.push({ ref, canonicalText: fact.canonicalText, sources: [...new Map(mapped
            .flatMap(claim => claim.evidence.map(entry => entry.source)).map(source => [sourceRefKey(source), source])).values()] })
        }
        if (!visit(used)) return failure('budget-exhausted', 'Node budget exhausted')
        const budget = chargeEvidence(items.map(item => item.canonicalText))
        if (!budget.ok) return budget
        const end = access()
        return end.ok ? success(structuredClone(items)) : end
      },
    })
    seedReaders.set(view, {
      async search(request) {
        const auth = access()
        if (!auth.ok) return auth
        if (request.protocolVersion !== MEMORY_GRAPH_PROTOCOL_VERSION || request.mode !== 'direct-only')
          return failure('unsupported-capability', 'Lexical seed search supports direct-only graph requests')
        if (!request.query.trim() || request.query.length > 2000 || !request.recallId.trim())
          return failure('invalid-request', 'Seed query must contain 1 to 2000 characters')
        const requiredEntities = request.entities ?? []
        if (requiredEntities.length > 1000 || requiredEntities.some(ref => ref.kind !== 'entity' || !ref.id.trim() || !Number.isSafeInteger(ref.version) || ref.version < 1))
          return failure('invalid-request', 'Invalid seed entity constraint')
        const entries = request.entries ?? {}
        for (const [kind, refs] of [['claim', entries.claims ?? []], ['entity', entries.entities ?? []], ['relation', entries.relations ?? []]] as const) {
          if (refs.length > 1000 || refs.some(ref => ref.kind !== kind || !ref.id.trim() || !Number.isSafeInteger(ref.version) || ref.version < 1))
            return failure('invalid-request', 'Invalid or excessive seed entry references')
        }
        const traversal = request.traversal
        if (((entries.relations?.length ?? 0) > 0 && !traversal)
          || (traversal && (!['in', 'out', 'both'].includes(traversal.direction) || traversal.kinds.length === 0
            || traversal.kinds.some(kind => !['causal', 'contributes-to', 'before'].includes(kind)))))
          return failure('invalid-request', 'Relation entries need valid relation types and direction')
        if ((request.expectedManifestId !== undefined && request.expectedManifestId !== manifest.manifestId)
          || !sameScope(request.scope, context.access.scope)
          || !isDeepStrictEqual(request.temporal, context.temporal)
          || !isDeepStrictEqual(request.budget, context.budget)
          || !isDeepStrictEqual([...request.sharePolicies].sort(), [...context.access.sharePolicies].sort())
          || !isDeepStrictEqual([...request.sensitivities].sort(), [...context.access.sensitivities].sort()))
          return failure('invalid-request', 'Seed request must match the existing read view')
        if (context.budget.maxSeeds === 0)
          return success({ items: [], scanned: 0, completion: 'budget-exhausted' })
        let query: ReturnType<typeof prepareGraphLexicalQuery>
        try { query = prepareGraphLexicalQuery(request.query) }
        catch { return failure('invalid-request', 'Use one valid explicit date, or plan relative times and date ranges before seed search') }
        const documents: { claim: GraphClaimRecord; content: string }[] = []
        let scanned = 0
        for (const claim of data.bundle.claims) {
          const fresh = access()
          if (!fresh.ok) return fresh
          if (seedScanned >= maxSeedScanned)
            return success({ items: [], scanned, completion: 'budget-exhausted' })
          scanned++
          seedScanned++
          const fact = facts.get(refKey(claim.fact))
          const matchesEntities = requiredEntities.every(ref => Object.values(claim.atom.args)
            .some(term => term.kind === 'entity' && refKey(term.ref) === refKey(ref)))
          if (matchesEntities && claimAllowed(claim, fresh.value) && fact && scopesIntersect(fact.scope, fresh.value.scope))
            documents.push({ claim, content: fact.canonicalText })
        }
        const candidates = new Map<string, GraphSeedCandidate & { ref: GraphClaimRef; origins: GraphSeedOrigin[] }>()
        const available = new Map(documents.map(document => [refKey(document.claim.ref), document]))
        const add = (ref: GraphClaimRef, relevance: number, origin: GraphSeedOrigin) => {
          const key = refKey(ref)
          const existing = candidates.get(key)
          if (existing) {
            if (!existing.origins.some(item => item.kind === origin.kind && refKey(item.ref) === refKey(origin.ref))) existing.origins.push(origin)
            if (relevance > existing.relevance) Object.assign(existing, { relevance, route: origin.kind === 'claim-text' ? 'lexical' : 'structured' })
          }
          else candidates.set(key, { ref, relevance, route: origin.kind === 'claim-text' ? 'lexical' : 'structured', origins: [origin] })
        }
        try {
          // Rank each implemented route before truncation, then fuse by exact Claim version.
          for (const hit of rankGraphLexicalSeeds(query, documents, 10000))
            add(hit.ref, hit.relevance, { kind: 'claim-text', ref: hit.ref })
          for (const ref of entries.claims ?? []) {
            const fresh = access()
            if (!fresh.ok) return fresh
            const document = available.get(refKey(ref))
            if (document && matchesGraphSeedQuery(query, document)) add(ref, 1, { kind: 'claim-ref', ref })
          }
          const entityEntries = new Map([...requiredEntities, ...entries.entities ?? []].map(ref => [refKey(ref), ref]))
          for (const ref of entityEntries.values()) {
            const fresh = access()
            if (!fresh.ok) return fresh
            const linked = [...entityClaims.get(refKey(ref)) ?? []].flatMap(key => available.has(key) ? [available.get(key)!] : [])
            // Entity membership is not relevance: retain the event text threshold on this route.
            for (const hit of rankGraphLexicalSeeds(query, linked, 10000))
              add(hit.ref, hit.relevance, { kind: 'entity-ref', ref })
          }
          for (const ref of new Map((entries.relations ?? []).map(ref => [refKey(ref), ref])).values()) {
            const fresh = access()
            if (!fresh.ok) return fresh
            if (seedScanned >= maxSeedScanned) return success({ items: [], scanned, completion: 'budget-exhausted' })
            seedScanned++
            scanned++
            const relation = relations.get(refKey(ref))
            if (!relation || !relationAllowed(relation, fresh.value) || !traversal!.kinds.includes(relation.kind)) continue
            const endpoints = traversal!.direction === 'in' ? [relation.to]
              : traversal!.direction === 'out' ? [relation.from] : [relation.from, relation.to]
            for (const endpoint of endpoints) {
              const document = available.get(refKey(endpoint))
              if (document && matchesGraphSeedQuery(query, document)) add(endpoint, 1, { kind: 'relation-ref', ref })
            }
          }
        }
        catch { return failure('source-unavailable', 'Eligible seed text could not be indexed') }
        // Score 1 denotes a host-resolved exact entry, not semantic certainty.
        const items = [...candidates.values()].sort((a, b) => b.relevance - a.relevance || refKey(a.ref).localeCompare(refKey(b.ref)))
          .slice(0, context.budget.maxSeeds)
        // No partial ranking on scan exhaustion. All statistics are computed
        // from eligible documents, not hidden or temporally unavailable claims.
        const end = access()
        if (!end.ok) return end
        if (items.some(item => !claimAllowed(claims.get(refKey(item.ref))!, end.value)
          || item.origins.some(origin => origin.kind === 'relation-ref' && !relationAllowed(relations.get(refKey(origin.ref))!, end.value))))
          return failure('source-unavailable', 'Seed eligibility changed during search')
        const keys = items.map(item => refKey(item.ref))
        if (new Set([...selectedSeeds, ...keys]).size > context.budget.maxSeeds || !visit(items.map(item => item.ref)))
          return success({ items: [], scanned, completion: 'budget-exhausted' })
        keys.forEach(key => selectedSeeds.add(key))
        return success({ items: structuredClone(items), scanned, completion: 'complete' })
      },
    })
    return success(view)
  }

  return {
    async openView(request) { return open(request) },
    manifest: () => ({ ...structuredClone(manifest), ...(stale ? { state: 'stale' as const } : {}) }),
    invalidate: () => { stale = true },
    revokeSource: episodeId => { tombstones.add(episodeId) },
    seedPort: { async search(request, view) {
      const reader = seedReaders.get(view)
      return reader ? reader.search(request, view) : failure('view-closed', 'Unknown read view')
    } },
    evidenceReader: {
      async readSources(view, refs) {
        const reader = readers.get(view)
        return reader ? reader.readSources(view, refs) : failure('view-closed', 'Unknown read view')
      },
      async resolveFactVersions(view, refs) {
        const reader = readers.get(view)
        return reader ? reader.resolveFactVersions(view, refs) : failure('view-closed', 'Unknown read view')
      },
    },
  }
}

function validRequest(request: GraphOpenViewRequest): boolean {
  const access = request.access
  const t = request.temporal
  return !!request.policyVersion.trim() && !!request.expectedManifestId.trim()
    && !!access.accessContextId.trim() && !!access.authorizationVersion.trim()
    && !!access.scope.ownerId.trim() && !!access.scope.agentId.trim()
    && (access.scope.sessionId === undefined || !!access.scope.sessionId.trim())
    && access.sharePolicies.every(value => ['allow-remote', 'local-only', 'ask'].includes(value))
    && access.sensitivities.every(value => ['normal', 'private', 'secret'].includes(value))
    && Number.isSafeInteger(t.knownAt)
    && (t.valid.kind === 'at' ? Number.isSafeInteger(t.valid.at)
      : t.valid.kind === 'overlap' && Number.isSafeInteger(t.valid.from) && Number.isSafeInteger(t.valid.to) && t.valid.from < t.valid.to)
    && ['maxSeeds', 'maxNodes', 'maxEdges', 'maxHops', 'maxRuleBindings', 'maxProofSteps', 'maxElapsedMs', 'maxEvidenceTokens']
      .every(key => { const value = request.budget[key as keyof typeof request.budget]; return Number.isSafeInteger(value) && value >= 0 })
}

function timeMatches(time: GraphTimeExtent, query: GraphTemporalQuery): boolean {
  if (time.kind !== 'interval') return false
  const from = time.from ?? Number.NEGATIVE_INFINITY
  const to = time.to ?? Number.POSITIVE_INFINITY
  return query.valid.kind === 'at' ? from <= query.valid.at && query.valid.at < to
    : from < query.valid.to && query.valid.from < to
}
function scopeContains(container: GraphScope, child: GraphScope): boolean {
  return container.ownerId === child.ownerId && container.agentId === child.agentId
    && (container.sessionId === undefined || container.sessionId === child.sessionId)
}
function scopesIntersect(a: GraphScope, b: GraphScope): boolean {
  return a.ownerId === b.ownerId && a.agentId === b.agentId
    && (a.sessionId === undefined || b.sessionId === undefined || a.sessionId === b.sessionId)
}
function sameScope(a: GraphScope, b: GraphScope): boolean { return scopeContains(a, b) && scopeContains(b, a) }
function refKey(ref: GraphVersionRef<string>): string { return JSON.stringify([ref.kind, ref.id, ref.version]) }
function sourceKey(ref: Pick<GraphSourceRef, 'episodeId' | 'contentHash'>): string { return JSON.stringify([ref.episodeId, ref.contentHash]) }
function sourceRefKey(ref: GraphSourceRef): string {
  return JSON.stringify([ref.episodeId, ref.contentHash, ref.locator.kind,
    ...(ref.locator.kind === 'text-span' ? [ref.locator.unit, ref.locator.start, ref.locator.end] : [])])
}
function success<T>(value: T): GraphResult<T> { return { ok: true, value } }
function failure(code: GraphProtocolErrorCode, message: string): { ok: false; error: { code: GraphProtocolErrorCode; message: string } } {
  return { ok: false, error: { code, message } }
}
