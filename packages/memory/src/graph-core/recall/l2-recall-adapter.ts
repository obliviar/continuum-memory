import type { GraphRelationRef, GraphResult, GraphSourceRef, GraphVersionRef, GraphClaimRef } from '@continuum-memory/contracts'
import type { GraphRelationKind, GraphRelationRecord } from '../domain/relation-types'
import type { GraphRecallRelationRecord, GraphRecallRelationEdge } from '../domain/recall-types'
import type { GraphReadPort, GraphReadView, GraphEvidenceReader, GraphSourceContent, GraphPage } from '../ports/graph-ports'
import type { GraphRelationReadPort, GraphRelationReadView } from '../ports/graph-relation-ports'
import type { GraphRecallReadView, GraphRecallReadPort, GraphRecallEvidenceReader, GraphRecallSeedPort, GraphSeedSearchRequest, GraphSeedCandidate } from '../ports/graph-recall-ports'

export interface L2RecallAdapterOptions {
  readonly coreReadPort: GraphReadPort
  readonly relationReadPort: GraphRelationReadPort
  readonly coreEvidenceReader: GraphEvidenceReader
  /** Trusted host reads exact relation evidence spans after authorization/tombstone checks. */
  readonly readRelationSources: (view: GraphRelationReadView, refs: readonly GraphSourceRef[]) => Promise<GraphResult<readonly GraphSourceContent[]>>
  /** Required to enforce a SINGLE combined L1 + L2 evidence budget. */
  readonly countTokens: (text: string) => number
  /** Host-resolved query seeds, not L2 write-time relation candidates/NLI observations. */
  readonly searchSeeds?: (request: GraphSeedSearchRequest, core: GraphReadView, relations: GraphRelationReadView) => Promise<GraphResult<GraphPage<GraphSeedCandidate>>>
}
const KINDS: readonly GraphRelationKind[] = ['entails', 'contradicts', 'causes', 'precedes', 'explains']

/** Read-only bridge. It neither publishes an L2 snapshot nor turns a model candidate into an edge. */
export function createL2GraphRecallAdapter(options: L2RecallAdapterOptions): {
  readPort: GraphRecallReadPort; evidenceReader: GraphRecallEvidenceReader; seedPort?: GraphRecallSeedPort
} {
  const sessions = new WeakMap<GraphRecallReadView, {
    core: GraphReadView; l2: GraphRelationReadView;
    check: () => Promise<GraphResult<void>>;
    charge: (texts: readonly string[]) => GraphResult<void>;
    owners: Map<string, Map<string, GraphRelationRef>>;
  }>()
  const readPort: GraphRecallReadPort = { async openView(request) {
    const context = structuredClone(request)
    if (!context.expectedRelationManifestId) return failure('invalid-request', 'L2 recall requires an exact relation manifest ID')
    const coreResult = await options.coreReadPort.openView(context)
    if (!coreResult.ok) return coreResult
    const core = coreResult.value
    let l2: GraphRelationReadView | undefined
    try {
      const opened = await options.relationReadPort.openView({ coreView: core, expectedRelationManifestId: context.expectedRelationManifestId })
      if (!opened.ok) { await core.close(); return opened }
      l2 = opened.value
      const relationView = l2
      if (l2.coreViewId !== core.viewId || l2.manifest.coreManifestId !== core.manifest.manifestId
        || l2.manifest.manifestId !== context.expectedRelationManifestId) {
        await l2.close(); await core.close()
        return failure('version-mismatch', 'L1 and L2 views are not pinned together')
      }
      let closed = false
      let scanned = 0
      let evidenceTokens = 0
      const owners = new Map<string, Map<string, GraphRelationRef>>()
      async function check(): Promise<GraphResult<void>> {
        if (closed) return failure('view-closed', 'Recall view is closed')
        const coreState = await core.resolveClaims([])
        if (!coreState.ok) return coreState
        const relationState = await relationView.resolveRelations([])
        return relationState.ok ? { ok: true, value: undefined } : relationState
      }
      function charge(texts: readonly string[]): GraphResult<void> {
        let cost = 0
        try {
          for (const text of texts) {
            const n = options.countTokens(text)
            if (!Number.isSafeInteger(n) || n < 0 || (text.length > 0 && n === 0)) return failure('invalid-request', 'Invalid tokenizer output')
            cost += n
          }
        } catch { return failure('not-ready', 'Host tokenizer is unavailable') }
        if (evidenceTokens + cost > context.budget.maxEvidenceTokens) return failure('budget-exhausted', 'Combined L1/L2 evidence budget exhausted')
        evidenceTokens += cost
        return { ok: true, value: undefined }
      }
      async function readClaims(refs: readonly GraphClaimRef[]) {
        const read = await core.resolveClaims(refs)
        if (!read.ok) return read
        if (read.value.length !== refs.length || read.value.some((claim, i) => key(claim.ref) !== key(refs[i]!)))
          return failure('source-unavailable', 'L1 did not return exact requested claims')
        const knownAt = context.temporal.knownAt
        if (read.value.some(claim => claim.review.status !== 'accepted' || claim.review.reviewedAt > knownAt
          || claim.modality !== 'asserted' || claim.condition.kind !== 'none' || claim.polarity === 'unknown'
          || claim.transactionTime.recordedAt > knownAt || (claim.transactionTime.closedAt !== null && knownAt >= claim.transactionTime.closedAt)
          || claim.validTime.kind === 'unknown'
          || (context.temporal.valid.kind === 'at'
            ? !((claim.validTime.from === null || claim.validTime.from <= context.temporal.valid.at) && (claim.validTime.to === null || context.temporal.valid.at < claim.validTime.to))
            : !((claim.validTime.from === null || claim.validTime.from < context.temporal.valid.to) && (claim.validTime.to === null || context.temporal.valid.from < claim.validTime.to)))
          || !claim.evidence.some(e => e.role === 'supports' && e.strength === 'direct')))
          return failure('source-unavailable', 'Claim is not eligible for direct factual recall')
        return read
      }
      async function eligible(record: GraphRelationRecord): Promise<GraphResult<GraphRecallRelationRecord>> {
        // Negative causes means NOT causes; hypothetical/planned/reported relations are not asserted positive edges.
        if (record.review.status !== 'accepted' || record.review.reviewedAt > context.temporal.knownAt
          || record.polarity !== 'positive' || record.modality !== 'asserted' || record.validTime.kind === 'unknown'
          || !record.evidence.some(e => e.role === 'supports')) return failure('source-unavailable', 'Relation is not eligible for direct factual traversal')
        const endpoints = await readClaims([record.from, record.to])
        if (!endpoints.ok) return endpoints
        if (endpoints.value.length !== 2 || endpoints.value.some((claim, i) => key(claim.ref) !== key(i === 0 ? record.from : record.to)))
          return failure('source-unavailable', 'Relation endpoints were not resolved exactly')
        for (const evidence of record.evidence) {
          const source = sourceKey(evidence.source)
          const refs = owners.get(source) ?? new Map<string, GraphRelationRef>()
          refs.set(key(record.ref), record.ref); owners.set(source, refs)
        }
        return { ok: true, value: { ...structuredClone(record), authoritativeRecord: structuredClone(record),
          assertion: 'explicit-claim', status: 'active', support: 'supported' } }
      }
      const view: GraphRecallReadView = {
        viewId: `recall:${core.viewId}:${l2.viewId}`, manifest: structuredClone(core.manifest), context: structuredClone(context),
        relationManifest: structuredClone(l2.manifest), conflictPolicy: core.conflictPolicy,
        async resolveClaims(refs) { const live = await check(); return live.ok ? readClaims(refs) : live },
        async resolveStatements(refs) { const live = await check(); return live.ok ? core.resolveStatements(refs) : live },
        async resolveRules(refs) { const live = await check(); return live.ok ? core.resolveRules(refs) : live },
        async matchRuleBody(query) { const live = await check(); return live.ok ? core.matchRuleBody(query) : live },
        async findConflicts(ref, page) { const live = await check(); return live.ok ? core.findConflicts(ref, page) : live },
        async resolveRelations(refs) {
          const live = await check(); if (!live.ok) return live
          const read = await relationView.resolveRelations(refs); if (!read.ok) return read
          if (read.value.length !== refs.length || read.value.some((record, i) => key(record.ref) !== key(refs[i]!)))
            return failure('source-unavailable', 'L2 did not return exact requested relations')
          const records: GraphRecallRelationRecord[] = []
          for (const record of read.value) { const result = await eligible(record); if (!result.ok) return result; records.push(result.value) }
          const end = await check(); return end.ok ? { ok: true, value: records } : end
        },
        async neighbors(query) {
          const live = await check(); if (!live.ok) return live
          if (query.layer !== 'semantic' || query.node.kind !== 'claim'
            || query.kinds.length === 0 || query.kinds.some(kind => !KINDS.includes(kind as GraphRelationKind)))
            return failure('unsupported-capability', 'L2 recall accepts canonical relation kinds only; legacy kinds are not implicitly translated')
          if (!Number.isSafeInteger(query.maxScanned) || query.maxScanned < 1) return failure('invalid-request', 'Invalid scan bound')
          const origin = await readClaims([query.node]); if (!origin.ok) return origin
          const remaining = context.budget.maxEdges - scanned
          if (remaining <= 0 || context.budget.maxHops === 0) return { ok: true, value: { items: [], scanned: 0, completion: 'budget-exhausted' } }
          const pageLimit = Math.min(query.maxScanned, remaining)
          const read = await relationView.neighbors({ claim: query.node, direction: query.direction,
            kinds: query.kinds as GraphRelationKind[], limit: query.limit, maxScanned: pageLimit, cursor: query.cursor })
          if (!read.ok) return read
          const page = read.value
          if (!Number.isSafeInteger(page.scanned) || page.scanned < 0 || page.scanned > pageLimit || page.items.length > page.scanned)
            return failure('invalid-request', 'L2 reader exceeded the neighbor page bound')
          scanned += page.scanned
          const items: GraphRecallRelationEdge[] = []
          for (const edge of page.items) {
            const record = await relationView.resolveRelations([edge.relation]); if (!record.ok) return record
            const actual = record.value[0]
            if (record.value.length !== 1 || !actual || key(actual.ref) !== key(edge.relation)
              || actual.kind !== edge.relationKind || key(actual.from) !== key(edge.from) || key(actual.to) !== key(edge.to)
              || actual.polarity !== edge.polarity || actual.modality !== edge.modality)
              return failure('version-mismatch', 'L2 projection and relation record disagree')
            const selected = await eligible(actual)
            if (!selected.ok) {
              if (selected.error.code === 'source-unavailable') continue
              if (selected.error.code === 'budget-exhausted') return { ok: true, value: { items, scanned: page.scanned, completion: 'budget-exhausted' } }
              return selected
            }
            items.push({ id: edge.id, layer: 'semantic', kind: actual.kind, from: actual.from, to: actual.to, relationRef: actual.ref })
          }
          const end = await check()
          return end.ok ? { ok: true, value: { ...page, items } } : end
        },
        async close() {
          if (closed) return
          closed = true
          try { await relationView.close() } finally { await core.close() }
        },
      }
      sessions.set(view, { core, l2: relationView, check, charge, owners })
      return { ok: true, value: view }
    } catch {
      try { if (l2) await l2.close() } finally { await core.close() }
      return failure('not-ready', 'Unable to open linked L1/L2 recall views')
    }
  } }
  const evidenceReader: GraphRecallEvidenceReader = {
    async resolveFactVersions(view, refs) {
      const session = sessions.get(view); if (!session) return failure('scope-denied', 'Unknown recall view')
      const live = await session.check(); if (!live.ok) return live
      const read = await options.coreEvidenceReader.resolveFactVersions(session.core, refs); if (!read.ok) return read
      const charged = session.charge(read.value.map(item => item.canonicalText)); if (!charged.ok) return charged
      const end = await session.check(); return end.ok ? read : end
    },
    async readSources(view, refs) {
      const session = sessions.get(view); if (!session) return failure('scope-denied', 'Unknown recall view')
      const live = await session.check(); if (!live.ok) return live
      const result: GraphSourceContent[] = []
      for (const ref of refs) {
        const owners = session.owners.get(sourceKey(ref))
        if (owners) {
          const valid = await view.resolveRelations([...owners.values()]); if (!valid.ok) return valid
        }
        const read = owners ? await options.readRelationSources(session.l2, [ref])
          : await options.coreEvidenceReader.readSources(session.core, [ref])
        if (!read.ok) return read
        if (read.value.length !== 1 || sourceKey(read.value[0]!.ref) !== sourceKey(ref))
          return failure('source-unavailable', 'Exact source span was not returned')
        result.push(read.value[0]!)
      }
      const charged = session.charge(result.map(source => source.content)); if (!charged.ok) return charged
      const end = await session.check(); return end.ok ? { ok: true, value: result } : end
    },
  }
  const seedPort: GraphRecallSeedPort | undefined = options.searchSeeds ? { async search(request, view) {
    const session = sessions.get(view); if (!session) return failure('scope-denied', 'Unknown recall view')
    const live = await session.check(); if (!live.ok) return live
    const read = await options.searchSeeds!(request, session.core, session.l2)
    const end = await session.check(); return end.ok ? read : end
  } } : undefined
  return { readPort, evidenceReader, seedPort }
}
function failure(code: 'invalid-request' | 'source-unavailable' | 'budget-exhausted' | 'scope-denied' | 'view-closed' | 'version-mismatch' | 'unsupported-capability' | 'not-ready', message: string): GraphResult<never> {
  return { ok: false, error: { code, message } }
}
function key(ref: GraphVersionRef<string>): string { return JSON.stringify([ref.kind, ref.id, ref.version]) }
function sourceKey(ref: GraphSourceRef): string {
  return JSON.stringify([ref.episodeId, ref.contentHash, ref.locator.kind,
    ...(ref.locator.kind === 'text-span' ? [ref.locator.unit, ref.locator.start, ref.locator.end] : [])])
}
