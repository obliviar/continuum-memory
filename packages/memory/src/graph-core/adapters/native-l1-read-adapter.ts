import type { GraphProtocolErrorCode, GraphResult } from '@continuum-memory/contracts'
import type { GraphProjectionSnapshot } from '../domain/types'
import type { GraphEvidenceReader, GraphReadView } from '../ports/graph-ports'
import type { V4L1Store } from '../repository/v4-l1-store'
import { graphHash } from './v4-semantic-adapter'

const fail = (code: GraphProtocolErrorCode, message: string): GraphResult<never> => ({ ok: false, error: { code, message } })
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}

/** Present the authoritative native L1 version through the existing live, permission-filtered reader.
 * No persisted manifest or relation endpoint is rewritten. Both views must remain unchanged.
 */
export function createNativeL1ReadAdapter(options: {
  base: V4L1Store
  projection: () => GraphProjectionSnapshot | undefined
}): V4L1Store {
  const native = options.projection(), baseSnapshot = options.base.snapshot()
  if (!native || native.manifest.state !== 'ready' || !baseSnapshot || baseSnapshot.manifest.state !== 'ready'
    || !same(native.manifest.scope, baseSnapshot.manifest.scope)
    || native.manifest.sourceRevisions.v4 !== baseSnapshot.manifest.sourceRevisions.v4)
    throw new Error('Native and authorized L1 views are not current')
  const pinned = structuredClone(native), fingerprint = graphHash(native)
  const baseId = baseSnapshot.manifest.manifestId
  const members = new Map(pinned.semanticBundle.claims.map(c => [graphHash(c.ref), c]))
  // Native references must describe exactly the same records the underlying reader will return.
  for (const claim of baseSnapshot.semanticBundle.claims) {
    const original = members.get(graphHash(claim.ref))
    if (original && !same(original, claim)) throw new Error('Native Claim content differs at the same version')
  }
  const sessions = new Map<string, { live: () => Promise<boolean>; close: () => Promise<void> }>()
  const readers = new WeakMap<GraphReadView, GraphEvidenceReader>()
  function current() {
    const next = options.projection()
    const authorized = options.base.snapshot()
    return !!next && graphHash(next) === fingerprint && authorized?.manifest.state === 'ready'
      && authorized.manifest.manifestId === baseId
  }
  const adapter: V4L1Store = {
    snapshot: () => {
      const copy = structuredClone(pinned)
      try { if (current()) return copy } catch { /* Source/read failure revokes this view. */ }
      return { ...copy, manifest: { ...copy.manifest, state: 'stale' } }
    },
    publishCurrent: () => fail('unsupported-capability', 'Native L1 publication belongs to its writer'),
    invalidate: () => { throw new Error('Native adapter is read-only; invalidate the authoritative repository') },
    isViewLive: async id => { try { return await sessions.get(id)?.live() ?? false } catch { return false } },
    async openView(request) {
      if (request.expectedManifestId !== pinned.manifest.manifestId)
        return fail('version-mismatch', 'Native L1 manifest mismatch')
      if (!current()) return fail('stale-projection', 'Native L1 changed')
      if (request.includeUnknownValidTime) return fail('unsupported-capability', 'Native L2 needs known valid time')
      const opened = await options.base.openView({ ...request, expectedManifestId: baseId })
      if (!opened.ok) return opened
      const base = opened.value
      let closed = false
      const close = async () => { closed = true; sessions.delete(base.viewId); await base.close() }
      const live = async () => !closed && current() && await options.base.isViewLive(base.viewId)
      async function guarded<T>(action: () => Promise<GraphResult<T>>): Promise<GraphResult<T>> {
        try {
          if (!await live()) return fail('stale-projection', 'Native or authorized L1 changed')
          const result = await action()
          return await live() ? result : fail('stale-projection', 'Native L1 changed during read')
        } catch { return fail('not-ready', 'Native L1 read failed') }
      }
      const unsupported = () => guarded(async () => fail('unsupported-capability', 'Native read bridge does not execute proofs or conflict audits'))
      const view: GraphReadView = {
        viewId: base.viewId, manifest: freeze(structuredClone(pinned.manifest)), context: freeze(structuredClone(request)), close,
        resolveClaims: refs => guarded(async () => {
          if (refs.some(ref => !members.has(graphHash(ref)))) return fail('source-unavailable', 'Claim is not in native L1')
          const result = await base.resolveClaims(refs)
          if (result.ok && result.value.some(c => !same(members.get(graphHash(c.ref)), c)))
            return fail('version-mismatch', 'Exact native Claim changed')
          return result
        }),
        resolveEntities: refs => guarded(async () => refs.some(ref => !pinned.semanticBundle.entities.some(e => same(e.ref, ref)))
          ? fail('source-unavailable', 'Entity is not in native L1')
          : base.resolveEntities ? base.resolveEntities(refs) : fail('unsupported-capability', 'Entity reading unavailable')),
        resolveStatements: unsupported, resolveRules: unsupported, neighbors: unsupported,
        matchRuleBody: unsupported, findConflicts: unsupported,
      }
      const reader: GraphEvidenceReader = {
        readSources: (_view, refs) => guarded(async () => refs.some(ref => !pinned.semanticBundle.claims.some(c => c.provenance.sources.some(s => same(s, ref))))
          ? fail('source-unavailable', 'Source is not in native L1') : options.base.evidenceReader.readSources(base, refs)),
        resolveFactVersions: (_view, refs) => guarded(async () => refs.some(ref => !pinned.semanticBundle.claims.some(c => same(c.fact, ref)))
          ? fail('source-unavailable', 'Fact is not in native L1') : options.base.evidenceReader.resolveFactVersions(base, refs)),
      }
      if (!await live()) { await close(); return fail('stale-projection', 'Native L1 changed during view open') }
      sessions.set(view.viewId, { live, close }); readers.set(view, reader)
      return { ok: true, value: Object.freeze(view) }
    },
    evidenceReader: {
      readSources: (view, refs) => readers.get(view)?.readSources(view, refs) ?? Promise.resolve(fail('view-closed', 'Unknown native view')),
      resolveFactVersions: (view, refs) => readers.get(view)?.resolveFactVersions(view, refs) ?? Promise.resolve(fail('view-closed', 'Unknown native view')),
    },
  }
  return adapter
}
