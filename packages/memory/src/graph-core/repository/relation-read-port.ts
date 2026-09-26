import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type {
  GraphProtocolErrorCode,
  GraphRelationRef,
  GraphResult,
  GraphSourceRef,
  GraphTemporalQuery,
  GraphTimeExtent,
} from '@continuum-memory/contracts'
import { projectGraphRelationEdges } from '../domain/relation-core'
import type { GraphRelationEdge, GraphRelationRecord } from '../domain/relation-types'
import type { GraphAccessContext, GraphPage } from '../ports/graph-ports'
import type {
  GraphRelationNeighborQuery,
  GraphRelationReadPort,
  GraphRelationReadView,
} from '../ports/graph-relation-ports'
import type { GraphRelationRepository } from './relation-repository'

export interface GraphRelationReadPortOptions {
  readonly repository: GraphRelationRepository
  /** The host must confirm that the underlying authorized L1 view remains open. */
  readonly isCoreViewLive: (viewId: string) => Promise<boolean>
  /** Recheck live source tombstones, exact versions, scope, and policy on every read. */
  readonly verifySources: (refs: readonly GraphSourceRef[], access: GraphAccessContext) => Promise<GraphResult<void>>
}

/** Pin L2 to the caller's L1 view; never expose candidate/model output as answer evidence. */
export function createGraphRelationReadPort(options: GraphRelationReadPortOptions): GraphRelationReadPort {
  let nextViewId = 0
  return {
    async openView(request) {
      const snapshot = options.repository.snapshot()
      const coreView = request.coreView
      if (snapshot.manifest.state !== 'ready')
        return error('stale-projection', 'Relation view is stale')
      if (snapshot.manifest.manifestId !== request.expectedRelationManifestId)
        return error('version-mismatch', 'Relation manifest changed')
      if (snapshot.manifest.coreManifestId !== coreView.manifest.manifestId
        || snapshot.manifest.sourceBundleId !== coreView.manifest.sourceBundleId)
        return error('version-mismatch', 'Relation and core views have different sources')
      if (coreView.manifest.state !== 'ready' || !await coreViewIsLive(options, coreView.viewId))
        return error('view-closed', 'Core view is not live')
      if (!sameScope(snapshot.manifest.scope, coreView.context.access.scope))
        return error('scope-denied', 'Relation view scope is not authorized')
      const pinnedId = snapshot.manifest.manifestId
      const viewId = `relation-view:${++nextViewId}:${pinnedId}`
      const cursorSecret = randomBytes(32)
      let closed = false

      async function checkLive(): Promise<GraphResult<void>> {
        if (closed || !await coreViewIsLive(options, coreView.viewId))
          return error('view-closed', 'Relation or core view is closed')
        const current = options.repository.snapshot()
        if (current.manifest.state !== 'ready' || current.manifest.manifestId !== pinnedId)
          return error('stale-projection', 'Relation snapshot changed after view open')
        return { ok: true, value: undefined }
      }

      async function authorize(relation: GraphRelationRecord): Promise<GraphResult<void>> {
        const access = coreView.context.access
        if (!sameScope(relation.scope, access.scope)
          || !access.sharePolicies.includes(relation.sharePolicy)
          || !access.sensitivities.includes(relation.sensitivity))
          return error('scope-denied', 'Relation is not authorized')
        try {
          return await options.verifySources(relation.provenance.sources, access)
        }
        catch {
          return error('source-unavailable', 'Relation sources could not be verified')
        }
      }

      const view: GraphRelationReadView = {
        viewId,
        coreViewId: coreView.viewId,
        manifest: clone(snapshot.manifest),
        async resolveRelations(refs: readonly GraphRelationRef[]) {
          const live = await checkLive()
          if (!live.ok)
            return live
          const byRef = new Map(snapshot.relations.map(relation => [refKey(relation.ref), relation]))
          const result: GraphRelationRecord[] = []
          for (const ref of refs) {
            const relation = byRef.get(refKey(ref))
            if (!relation || !visibleAt(relation, coreView.context.temporal))
              return error('source-unavailable', 'Exact relation version is unavailable at the requested time')
            const allowed = await authorize(relation)
            if (!allowed.ok)
              return allowed
            result.push(clone(relation))
          }
          const stillLive = await checkLive()
          if (!stillLive.ok)
            return stillLive
          return { ok: true, value: result }
        },
        async neighbors(query: GraphRelationNeighborQuery) {
          const live = await checkLive()
          if (!live.ok)
            return live
          if (!Number.isSafeInteger(query.limit) || query.limit <= 0
            || !Number.isSafeInteger(query.maxScanned) || query.maxScanned <= 0)
            return error('invalid-request', 'Relation page limits must be positive integers')
          if (query.claim.kind !== 'claim' || !query.claim.id || !Number.isSafeInteger(query.claim.version)
            || query.claim.version <= 0 || !['out', 'in', 'both'].includes(query.direction)
            || !Array.isArray(query.kinds))
            return error('invalid-request', 'Invalid relation neighbor query')
          const maxScanned = Math.min(query.maxScanned, coreView.context.budget.maxEdges)
          const fingerprint = hash(JSON.stringify([viewId, query.claim, query.direction, query.kinds, maxScanned]))
          let offset = 0
          let scannedBefore = 0
          if (query.cursor !== undefined) {
            const cursor = parseCursor(query.cursor, cursorSecret)
            if (!cursor || cursor.fingerprint !== fingerprint || cursor.offset < 0 || cursor.scanned < 0)
              return error('invalid-request', 'Relation cursor does not match this view and query')
            offset = cursor.offset
            scannedBefore = cursor.scanned
          }
          const byRef = new Map(snapshot.relations.map(relation => [refKey(relation.ref), relation]))
          const eligible = projectGraphRelationEdges(snapshot, coreView.context.temporal.knownAt)
            .filter(edge => matchesNeighbor(edge, query)
              && matchesValidTime(edge.validTime, coreView.context.temporal)
              && authorizedByPolicy(byRef.get(refKey(edge.relation))!, coreView.context.access))
            .sort((a, b) => a.id.localeCompare(b.id))
          if (offset > eligible.length || scannedBefore > maxScanned)
            return error('invalid-request', 'Relation cursor is outside the result set')
          const count = Math.min(query.limit, maxScanned - scannedBefore, eligible.length - offset)
          const items = eligible.slice(offset, offset + count)
          for (const edge of items) {
            const relation = byRef.get(refKey(edge.relation))!
            const allowed = await authorize(relation)
            if (!allowed.ok)
              return allowed
          }
          const nextOffset = offset + count
          const scanned = scannedBefore + count
          const stillLive = await checkLive()
          if (!stillLive.ok)
            return stillLive
          const nextCursor = encodeCursor({ fingerprint, offset: nextOffset, scanned }, cursorSecret)
          const detachedItems = clone(items)
          const page: GraphPage<GraphRelationEdge> = nextOffset >= eligible.length
            ? { items: detachedItems, scanned: count, completion: 'complete' }
            : scanned >= maxScanned
              ? { items: detachedItems, scanned: count, completion: 'budget-exhausted', nextCursor }
              : { items: detachedItems, scanned: count, completion: 'more', nextCursor }
          return { ok: true, value: page }
        },
        async close() { closed = true },
      }
      return { ok: true, value: view }
    },
  }
}

function matchesNeighbor(edge: GraphRelationEdge, query: GraphRelationNeighborQuery): boolean {
  if (!query.kinds.includes(edge.relationKind))
    return false
  const from = refKey(edge.from) === refKey(query.claim)
  const to = refKey(edge.to) === refKey(query.claim)
  if (edge.relationKind === 'contradicts')
    return from || to
  return query.direction === 'both' ? from || to : query.direction === 'out' ? from : to
}

function authorizedByPolicy(relation: GraphRelationRecord, access: GraphAccessContext): boolean {
  return sameScope(relation.scope, access.scope)
    && access.sharePolicies.includes(relation.sharePolicy)
    && access.sensitivities.includes(relation.sensitivity)
}

function visibleAt(relation: GraphRelationRecord, temporal: GraphTemporalQuery): boolean {
  const { knownAt } = temporal
  return relation.transactionTime.recordedAt <= knownAt
    && (relation.transactionTime.closedAt === null || knownAt < relation.transactionTime.closedAt)
    && matchesValidTime(relation.validTime, temporal)
}

function matchesValidTime(time: GraphTimeExtent, temporal: GraphTemporalQuery): boolean {
  if (time.kind === 'unknown')
    return true
  if (temporal.valid.kind === 'at')
    return (time.from === null || time.from <= temporal.valid.at)
      && (time.to === null || temporal.valid.at < time.to)
  return (time.from === null || time.from < temporal.valid.to)
    && (time.to === null || temporal.valid.from < time.to)
}

function sameScope(a: { ownerId: string; agentId: string; sessionId?: string }, b: { ownerId: string; agentId: string; sessionId?: string }): boolean {
  return a.ownerId === b.ownerId && a.agentId === b.agentId && a.sessionId === b.sessionId
}

async function coreViewIsLive(options: GraphRelationReadPortOptions, viewId: string): Promise<boolean> {
  try {
    return await options.isCoreViewLive(viewId)
  }
  catch {
    return false
  }
}

function refKey(ref: { kind: string; id: string; version: number }): string {
  return `${ref.kind}\u0000${ref.id}\u0000${ref.version}`
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

interface Cursor { fingerprint: string; offset: number; scanned: number }

function encodeCursor(cursor: Cursor, secret: Buffer): string {
  const payload = Buffer.from(JSON.stringify(cursor)).toString('base64url')
  const signature = createHmac('sha256', secret).update(payload).digest('base64url')
  return `${payload}.${signature}`
}

function parseCursor(value: string, secret: Buffer): Cursor | null {
  try {
    const [payload, signature, extra] = value.split('.')
    if (!payload || !signature || extra !== undefined)
      return null
    const expected = createHmac('sha256', secret).update(payload).digest('base64url')
    const actualBytes = Buffer.from(signature)
    const expectedBytes = Buffer.from(expected)
    if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes))
      return null
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Cursor
    return typeof parsed.fingerprint === 'string' && Number.isSafeInteger(parsed.offset)
      && Number.isSafeInteger(parsed.scanned) ? parsed : null
  }
  catch {
    return null
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function error(code: GraphProtocolErrorCode, description: string): GraphResult<never> {
  return { ok: false, error: { code, message: description } }
}
