import { randomUUID } from 'node:crypto'
import type { GraphProtocolErrorCode, GraphResult, GraphScope } from '@continuum-memory/contracts'
import type { GraphProjectionSnapshot } from '../domain/types'
import type { GraphAccessContext, GraphEvidenceReader, GraphReadPort, GraphReadView } from '../ports/graph-ports'
import type { V4GraphMemoryOptions } from '../adapters/v4-graph-memory'
import { collectCurrentL1, claimMatchesTime } from '../adapters/accepted-l1-input'
import { graphHash, V4_SCALAR_MAPPING_POLICY } from '../adapters/v4-semantic-adapter'
import { parseTurnFactFence, isTurnFactVisible } from '../recall/turn-fact-fence'

const SCHEMA = 'v4-l1-publication/v1'
type Options = Pick<V4GraphMemoryOptions, 'repository' | 'persistence' | 'authorizeScope' | 'canRead' | 'countTokens' | 'now' | 'acceptedBundle' | 'includeOwnedSessions'> & {
  resolveAccess: (id: string) => GraphAccessContext | undefined
}
export interface V4L1Store extends GraphReadPort {
  snapshot: () => GraphProjectionSnapshot | undefined
  /** Full current host-authorized scope; never filtered by query text or valid-time question. */
  publishCurrent: (request: { operationId: string; scope: GraphScope; expectedManifestId: string | null }) => GraphResult<{ manifestId: string }>
  invalidate: () => void
  isViewLive: (viewId: string) => Promise<boolean>
  evidenceReader: GraphEvidenceReader
}
const fail = (code: GraphProtocolErrorCode, message: string): GraphResult<never> => ({ ok: false, error: { code, message } })
const success = <T>(value: T): GraphResult<T> => ({ ok: true, value })
const same = (a: unknown, b: unknown) => graphHash(a) === graphHash(b)
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}

/** Single-host synchronous CAS over the existing atomic encrypted checkpoint, not a multi-process database. */
export function createV4L1Store(options: Options): V4L1Store {
  const now = options.now ?? Date.now
  let payload = options.persistence.load()
  let current: GraphProjectionSnapshot | undefined
  if (payload && payload !== '{}') {
    const saved = JSON.parse(payload)
    // Legacy per-query checkpoints are rebuilt, never served as fixed views.
    if (saved.schema === SCHEMA && saved.policy !== 'v4-verified-scalar-v1') {
      if (saved.policy !== V4_SCALAR_MAPPING_POLICY || !saved.projection?.manifest?.manifestId)
        throw new Error('Invalid L1 publication')
      current = saved.projection
    }
  }
  let generation = 0
  let writing = false
  const sessions = new Map<string, { check: () => GraphResult<void>; close: () => void; deadline: number }>()
  const readers = new WeakMap<GraphReadView, GraphEvidenceReader>()
  function capture(scope: GraphScope) {
    if (!options.authorizeScope(scope)) throw new Error('Scope is not authorized')
    const source = options.repository.snapshot()
    if (source.facts.length > 10000) throw new Error('Source scan limit exceeded')
    const gathered = collectCurrentL1(options, scope, now())
    if (!options.authorizeScope(scope)) throw new Error('Scope authorization changed')
    return gathered
  }
  function revokeViews() { generation++; for (const session of sessions.values()) session.close(); sessions.clear() }
  const store: V4L1Store = {
    snapshot: () => {
      if (!current) return undefined
      const copy = structuredClone(current)
      try {
        if (options.persistence.load() !== payload || !same(capture(copy.manifest.scope).projection, copy))
          return { ...copy, manifest: { ...copy.manifest, state: 'stale' } }
      } catch { return { ...copy, manifest: { ...copy.manifest, state: 'stale' } } }
      return copy
    },
    publishCurrent(request) {
      if (writing) return fail('not-ready', 'L1 publication is in progress')
      if (!request.operationId?.trim()) return fail('invalid-request', 'Publication needs an operation ID')
      if (!options.authorizeScope(request.scope)) return fail('scope-denied', 'Scope not authorized')
      if (request.expectedManifestId !== (current?.manifest.manifestId ?? null)
        || options.persistence.load() !== payload) return fail('version-mismatch', 'L1 publication changed; reload before publishing')
      writing = true
      try {
        const next = capture(request.scope)
        const nextPayload = JSON.stringify({ schema: SCHEMA, policy: V4_SCALAR_MAPPING_POLICY, projection: next.projection })
        if (options.persistence.load() !== payload) return fail('version-mismatch', 'L1 changed while preparing publication')
        if (nextPayload !== payload) {
          options.persistence.save(nextPayload)
          if (options.persistence.load() !== nextPayload) {
            revokeViews(); return fail('version-mismatch', 'Persistence did not retain the complete L1 publication')
          }
          // A trusted persistence callback can trigger a lifecycle update. Never acknowledge it as current.
          if (!same(capture(request.scope).projection, next.projection)) {
            revokeViews(); return fail('stale-projection', 'Source changed during L1 publication')
          }
          revokeViews(); current = structuredClone(next.projection); payload = nextPayload
        }
        return success({ manifestId: next.projection.manifest.manifestId })
      } catch { return fail('not-ready', 'L1 source validation or persistence failed') }
      finally { writing = false }
    },
    invalidate() {
      if (writing) throw new Error('Cannot invalidate during L1 publication')
      revokeViews()
      // Failed erasure throws; in-memory views remain revoked even if the disk write fails.
      options.persistence.save('{}'); payload = '{}'; current = undefined
    },
    async isViewLive(id) { try { return sessions.get(id)?.check().ok ?? false } catch { return false } },
    async openView(request) {
      try {
        const started = performance.now()
        const context = structuredClone(request)
        const fence = parseTurnFactFence(context.visibleFacts)
        if (!fence.ok) return fence
        const visibleFacts = fence.value
        if (!context.access?.accessContextId || !context.access.authorizationVersion
          || context.policyVersion !== V4_SCALAR_MAPPING_POLICY || context.expectedHierarchyManifestId)
          return fail('unsupported-capability', 'Only current scalar L1 views are available')
        if (!current) return fail('not-ready', 'No L1 publication')
        if (context.expectedManifestId !== current.manifest.manifestId) return fail('version-mismatch', 'L1 manifest mismatch')
        if (!same(context.access.scope, current.manifest.scope)) return fail('scope-denied', 'Exact scope required')
        const pinned = structuredClone(current), pinnedPayload = payload, epoch = generation
        const captured = capture(context.access.scope)
        if (!same(captured.projection, pinned)) return fail('stale-projection', 'Published L1 no longer matches current sources')
        const temporal = context.temporal
        if (!Number.isSafeInteger(temporal?.knownAt) || (visibleFacts === undefined && temporal.knownAt < captured.source.updatedAt) || temporal.knownAt > now())
          return fail('unsupported-capability', 'Historical transaction views are unavailable')
        if (!(temporal.valid?.kind === 'at' ? Number.isSafeInteger(temporal.valid.at)
          : temporal.valid?.kind === 'overlap' && Number.isSafeInteger(temporal.valid.from)
            && Number.isSafeInteger(temporal.valid.to) && temporal.valid.from < temporal.valid.to)
          || !context.budget || ['maxSeeds', 'maxNodes', 'maxEdges', 'maxHops', 'maxRuleBindings', 'maxProofSteps', 'maxElapsedMs', 'maxEvidenceTokens']
            .some(key => { const n = context.budget[key as keyof typeof context.budget]; return !Number.isSafeInteger(n) || n < 0 })
          || !Array.isArray(context.access.sharePolicies) || !Array.isArray(context.access.sensitivities))
          return fail('invalid-request', 'Invalid view time, policy or budget')
        for (const session of sessions.values()) if (session.deadline <= started) session.close()
        if (sessions.size >= 128) return fail('budget-exhausted', 'Too many open L1 views; close an existing view')
        const viewId = randomUUID()
        let closed = false, tokens = 0
        const nodes = new Set<string>()
        const close = () => { closed = true; sessions.delete(viewId) }
        function check(): GraphResult<void> {
          if (closed) return fail('view-closed', 'L1 view closed')
          if (epoch !== generation || options.persistence.load() !== pinnedPayload) return fail('stale-projection', 'L1 publication changed')
          const grant = options.resolveAccess(context.access.accessContextId)
          if (!grant || grant.accessContextId !== context.access.accessContextId
            || grant.authorizationVersion !== context.access.authorizationVersion || !same(grant.scope, context.access.scope)
            || !context.access.sharePolicies.every(p => grant.sharePolicies.includes(p))
            || !context.access.sensitivities.every(p => grant.sensitivities.includes(p))
            || !options.authorizeScope(context.access.scope)) return fail('scope-denied', 'L1 authorization revoked or changed')
          if (performance.now() - started >= context.budget.maxElapsedMs) return fail('budget-exhausted', 'L1 view elapsed budget exhausted')
          try {
            if (!same(capture(context.access.scope).projection, pinned)) return fail('stale-projection', 'L1 source or policy changed')
          } catch { return fail('stale-projection', 'L1 source validation failed') }
          return success(undefined)
        }
        const valid = check(); if (!valid.ok) return valid
        const inputs = new Map(captured.inputs.map(i => [i.fact.id, i]))
        function eligible(claim: GraphProjectionSnapshot['semanticBundle']['claims'][number]) {
          return isTurnFactVisible(visibleFacts, claim.fact)
            && context.access.sharePolicies.includes(claim.sharePolicy) && context.access.sensitivities.includes(claim.sensitivity)
            && claimMatchesTime(claim, temporal, context.includeUnknownValidTime === true)
        }
        function charge(values: unknown[]): GraphResult<void> {
          if (!values.length) return success(undefined)
          const cost = options.countTokens(JSON.stringify(values))
          if (!Number.isSafeInteger(cost) || cost < 0) return fail('invalid-request', 'Invalid token counter')
          if (tokens + cost > context.budget.maxEvidenceTokens) return fail('budget-exhausted', 'L1 evidence read budget exhausted')
          tokens += cost; return success(undefined)
        }
        function chargeNodes(claims: GraphProjectionSnapshot['semanticBundle']['claims']): GraphResult<void> {
          const next = new Set([...nodes, ...claims.map(c => graphHash(c.ref))])
          if (next.size > context.budget.maxNodes) return fail('budget-exhausted', 'L1 node budget exhausted')
          next.forEach(n => nodes.add(n)); return success(undefined)
        }
        async function guarded<T>(action: () => GraphResult<T>): Promise<GraphResult<T>> {
          try {
            const before = check(); if (!before.ok) return before
            const result = action(); if (!result.ok) return result
            const after = check(); return after.ok ? result : after
          } catch { return fail('not-ready', 'L1 view read failed') }
        }
        const unsupported = () => guarded(() => fail('unsupported-capability', 'This L1 view does not execute relations, proofs or conflict audits'))
        const view: GraphReadView = {
          viewId, manifest: freeze(structuredClone(pinned.manifest)), context: freeze(structuredClone(context)),
          resolveEntities: refs => guarded(() => {
            const records = []
            for (const ref of refs) {
              const entity = pinned.semanticBundle.entities.find(e => same(e.ref, ref))
              if (!entity || entity.review.status !== 'accepted' || entity.review.reviewedAt > temporal.knownAt
                || !context.access.sharePolicies.includes(entity.sharePolicy) || !context.access.sensitivities.includes(entity.sensitivity)
                || !pinned.semanticBundle.claims.some(c => eligible(c) && Object.values(c.atom.args).some(t => t.kind === 'entity' && same(t.ref, ref))))
                return fail('source-unavailable', 'Exact eligible Entity unavailable')
              records.push(entity)
            }
            const next = new Set([...nodes, ...records.map(e => graphHash(e.ref))])
            if (next.size > context.budget.maxNodes) return fail('budget-exhausted', 'L1 entity node budget exhausted')
            const charged = charge(records); if (!charged.ok) return charged
            next.forEach(n => nodes.add(n))
            return success(structuredClone(records))
          }),
          resolveClaims: refs => guarded(() => {
            const records = []
            for (const ref of refs) {
              const claim = pinned.semanticBundle.claims.find(c => same(c.ref, ref))
              if (!claim || !eligible(claim)) return fail('source-unavailable', 'Exact eligible Claim unavailable')
              records.push(claim)
            }
            const charged = chargeNodes(records)
            return charged.ok ? success(structuredClone(records)) : charged
          }),
          resolveStatements: refs => refs.length ? unsupported() : guarded(() => success([])),
          resolveRules: refs => refs.length ? unsupported() : guarded(() => success([])),
          neighbors: unsupported, matchRuleBody: unsupported, findConflicts: unsupported,
          close: async () => close(),
        }
        const reader: GraphEvidenceReader = {
          readSources: (_view, refs) => guarded(() => {
            const values = []
            const owners = []
            for (const ref of refs) {
              const claim = pinned.semanticBundle.claims.find(c => eligible(c) && c.provenance.sources.some(s =>
                same(s, ref)))
              const source = claim && inputs.get(claim.fact.id)?.sources.find(s => s.episode.id === ref.episodeId)
              if (!source || !claim) return fail('source-unavailable', 'Exact source unavailable in this view')
              owners.push(claim)
              let content = source.episode.content!
              if (ref.locator.kind === 'text-span') {
                const { start, end, unit } = ref.locator
                if (unit !== 'utf16' || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
                  || start < 0 || start >= end || end > content.length) return fail('invalid-request', 'Invalid source span')
                if ([start, end].some(offset => content.charCodeAt(offset - 1) >= 0xD800 && content.charCodeAt(offset - 1) <= 0xDBFF
                  && content.charCodeAt(offset) >= 0xDC00 && content.charCodeAt(offset) <= 0xDFFF))
                  return fail('invalid-request', 'Source span splits a surrogate pair')
                content = content.slice(start, end)
              } else if (ref.locator.kind !== 'whole-content') return fail('unsupported-capability', 'Unsupported locator')
              values.push({ ref: structuredClone(ref), content, scope: structuredClone(source.episode.scope) })
            }
            const visited = chargeNodes(owners); if (!visited.ok) return visited
            const charged = charge(values); return charged.ok ? success(values) : charged
          }),
          resolveFactVersions: (_view, refs) => guarded(() => {
            const values = []
            const owners = []
            for (const ref of refs) {
              const claim = pinned.semanticBundle.claims.find(c => same(c.fact, ref) && eligible(c))
              if (!claim) return fail('source-unavailable', 'Exact fact version unavailable')
              owners.push(claim)
              values.push({ ref: structuredClone(ref), canonicalText: inputs.get(ref.id)!.fact.canonicalText,
                sources: structuredClone(claim.provenance.sources) })
            }
            const visited = chargeNodes(owners); if (!visited.ok) return visited
            const charged = charge(values); return charged.ok ? success(values) : charged
          }),
        }
        sessions.set(viewId, { check, close, deadline: started + context.budget.maxElapsedMs }); readers.set(view, reader)
        return success(Object.freeze(view))
      } catch { return fail('not-ready', 'Unable to open L1 view') }
    },
    evidenceReader: {
      readSources: (view, refs) => readers.get(view)?.readSources(view, refs) ?? Promise.resolve(fail('view-closed', 'Unknown L1 view')),
      resolveFactVersions: (view, refs) => readers.get(view)?.resolveFactVersions(view, refs) ?? Promise.resolve(fail('view-closed', 'Unknown L1 view')),
    },
  }
  return store
}
