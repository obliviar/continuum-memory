import type { GraphResult, GraphScope, GraphSourceRef } from '@continuum-memory/contracts'
import type { GraphAccessContext, GraphSourceContent } from '../ports/graph-ports'
import type { GraphRelationRecord } from '../domain/relation-types'
import type { V4GraphMemoryOptions } from './v4-graph-memory'
import { graphHash, sourceHash } from './v4-semantic-adapter'

/** Source text is always read from current V4, never from a cached L2/NLI record. */
export function createV4RelationSourceReader(options: V4GraphMemoryOptions) {
  const sameScope = (a: GraphScope, b: GraphScope) => a.ownerId === b.ownerId && a.agentId === b.agentId && a.sessionId === b.sessionId
  function read(refs: readonly GraphSourceRef[], access: GraphAccessContext): GraphResult<readonly GraphSourceContent[]> {
    if (!options.authorizeScope(access.scope)) return { ok: false, error: { code: 'scope-denied', message: 'Source scope denied' } }
    const snapshot = options.repository.snapshot(), values: GraphSourceContent[] = []
    for (const ref of refs) {
      const ep = snapshot.episodes.find(e => e.id === ref.episodeId)
      if (!ep || !sameScope(ep.scope, access.scope) || ep.contentState !== 'available' || ep.deletedAt !== undefined
        || !ep.content || sourceHash(ep.content) !== ref.contentHash || (ep.contentHash !== undefined && ep.contentHash !== ref.contentHash)
        || !options.canRead(structuredClone(ep)) || !access.sharePolicies.includes(ep.sharePolicy) || !access.sensitivities.includes(ep.sensitivity))
        return { ok: false, error: { code: 'source-unavailable', message: 'Exact authorized relation source unavailable' } }
      let content = ep.content
      if (ref.locator.kind === 'text-span') {
        const { start, end, unit } = ref.locator
        if (unit !== 'utf16' || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= end || end > content.length
          || [start, end].some(i => content.charCodeAt(i - 1) >= 0xD800 && content.charCodeAt(i - 1) <= 0xDBFF
            && content.charCodeAt(i) >= 0xDC00 && content.charCodeAt(i) <= 0xDFFF))
          return { ok: false, error: { code: 'source-unavailable', message: 'Invalid relation source span' } }
        content = content.slice(start, end)
      } else if (ref.locator.kind !== 'whole-content') return { ok: false, error: { code: 'unsupported-capability', message: 'Unsupported source locator' } }
      values.push({ ref: structuredClone(ref), scope: structuredClone(ep.scope), content })
    }
    if (!options.authorizeScope(access.scope) || graphHash(snapshot) !== graphHash(options.repository.snapshot())
      || refs.some(ref => !options.canRead(structuredClone(snapshot.episodes.find(e => e.id === ref.episodeId)!))))
      return { ok: false, error: { code: 'stale-projection', message: 'Relation source changed while reading' } }
    return { ok: true, value: values }
  }
  async function verify(refs: readonly GraphSourceRef[], scope: GraphScope, records: readonly GraphRelationRecord[]): Promise<GraphResult<void>> {
    const access: GraphAccessContext = { accessContextId: 'host-publication', authorizationVersion: 'publication', scope,
      sharePolicies: ['local-only', 'ask', 'allow-remote'], sensitivities: ['normal', 'private', 'secret'] }
    const result = read(refs, access); if (!result.ok) return result
    const snapshot = options.repository.snapshot()
    for (const record of records) for (const source of record.provenance.sources) {
      const ep = snapshot.episodes.find(e => e.id === source.episodeId)
      if (!ep || ['normal', 'private', 'secret'].indexOf(record.sensitivity) < ['normal', 'private', 'secret'].indexOf(ep.sensitivity)
        || ['allow-remote', 'ask', 'local-only'].indexOf(record.sharePolicy) < ['allow-remote', 'ask', 'local-only'].indexOf(ep.sharePolicy))
        return { ok: false, error: { code: 'scope-denied', message: 'Relation weakens source policy' } }
    }
    return { ok: true, value: undefined }
  }
  return { read, verify }
}
