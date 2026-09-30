import { createHash } from 'node:crypto'
import { MEMORY_GRAPH_PROTOCOL_VERSION } from '@continuum-memory/contracts'
import type { MemoryV4Repository } from '../../v4/repository/memory-v4-repository'
import type { GraphL1Store } from '../../long-term/graph-l1-write'
import type { CaptureRepository } from '../../long-term/capture-repository'
import { projectCapturedInformation } from './captured-information'
import type { GraphProjectionSnapshot, GraphSemanticBundle, GraphSemanticEdge } from '../domain/types'
import type { GraphSemanticRepository } from './semantic-repository'
import { exactClaimAvailable } from './semantic-repository'
import type { GraphExtractionResultStore } from '../../long-term/graph-extraction-result'
import { projectOpenAssertions } from './open-assertions'

export const GRAPH_L1_PROJECTION_VERSION = 'accepted-l1-projection-v1'

export interface GraphL1ProjectionRepository {
  /** Only a ready projection of the current exact semantic and V4 revisions is visible. */
  snapshot: () => GraphProjectionSnapshot | undefined
  sync: () => GraphProjectionSnapshot | undefined
  /** Immediately hides a view when its accepted Claim source set changes. */
  invalidate: () => void
}

export function createGraphL1ProjectionRepository(persistence: { load: () => string | undefined; save: (value: string) => void },
  semantic: GraphSemanticRepository, v4: MemoryV4Repository, l1?: GraphL1Store,
  captures?: CaptureRepository, extractions?: GraphExtractionResultStore): GraphL1ProjectionRepository {
  const raw = persistence.load()
  let current = raw ? JSON.parse(raw) as GraphProjectionSnapshot : undefined
  if (current && (current.manifest?.schemaVersion !== 1 || current.manifest.builderVersion !== GRAPH_L1_PROJECTION_VERSION
    || !Array.isArray(current.edges) || !Array.isArray(current.derivedClaims) || !Array.isArray(current.proofs)
    || !Array.isArray(current.semanticBundle?.claims)))
    throw new Error('Invalid L1 graph projection')
  const eligible = (view: GraphProjectionSnapshot | undefined, bundle: GraphSemanticBundle | undefined): view is GraphProjectionSnapshot => {
    if (!view || !bundle || view.manifest.state !== 'ready' || view.manifest.sourceBundleId !== bundle.bundleId
      || view.manifest.protocolVersion !== MEMORY_GRAPH_PROTOCOL_VERSION
      || view.semanticBundle.bundleId !== bundle.bundleId || view.manifest.sourceRevisions.v4 !== v4.snapshot().revision
      || JSON.stringify(view.manifest.scope) !== JSON.stringify(bundle.scope)
      || JSON.stringify(view.manifest.sourceRevisions) !== JSON.stringify(bundle.revisions))
      return false
    const snapshot = v4.snapshot()
    try {
      const expected = buildProjection(bundle)
      return sameLiveClaims(bundle, snapshot, l1) && sameLiveInformation(bundle, captures, extractions)
        && bundle.claims.every(claim => exactClaimAvailable(claim, snapshot))
        && fingerprint(bundle) === view.manifest.semanticFingerprint
        && JSON.stringify(bundle) === JSON.stringify(view.semanticBundle)
        && expected.manifest.manifestId === view.manifest.manifestId
        && JSON.stringify(expected.edges) === JSON.stringify(view.edges)
        && view.derivedClaims.length === 0 && view.proofs.length === 0
    }
    catch { return false }
  }
  return {
    invalidate() {
      if (!current || current.manifest.state === 'stale') return
      const stale: GraphProjectionSnapshot = { ...current, manifest: { ...current.manifest, state: 'stale' } }
      current = stale
      persistence.save(JSON.stringify(stale))
    },
    snapshot() {
      const bundle = semantic.snapshot()
      return eligible(current, bundle) ? structuredClone(current) : undefined
    },
    sync() {
      const bundle = semantic.snapshot()
      if (!bundle || bundle.revisions.v4 !== v4.snapshot().revision
        || !sameLiveClaims(bundle, v4.snapshot(), l1) || !sameLiveInformation(bundle, captures, extractions)
        || !bundle.claims.every(claim => exactClaimAvailable(claim, v4.snapshot())))
        return undefined
      if (eligible(current, bundle)) return structuredClone(current)
      const view = buildProjection(bundle)
      persistence.save(JSON.stringify(view))
      current = view
      return structuredClone(view)
    },
  }
}

function sameLiveInformation(bundle: GraphSemanticBundle, captures?: CaptureRepository, extractions?: GraphExtractionResultStore): boolean {
  return (!captures || JSON.stringify(bundle.information ?? []) === JSON.stringify(projectCapturedInformation(captures.snapshot(), bundle.scope)))
    && (!extractions || !!captures && JSON.stringify(bundle.openAssertions ?? [])
      === JSON.stringify(projectOpenAssertions(captures.snapshot(), extractions, bundle.scope)))
}

function sameLiveClaims(bundle: GraphSemanticBundle,
  snapshot: ReturnType<MemoryV4Repository['snapshot']>, l1?: GraphL1Store): boolean {
  if (!l1) return true
  const live = l1.claims().filter(claim => claim.scope.ownerId === bundle.scope.ownerId
    && claim.scope.agentId === bundle.scope.agentId && claim.scope.sessionId === bundle.scope.sessionId
    && exactClaimAvailable(claim, snapshot))
    .sort((a, b) => a.ref.id.localeCompare(b.ref.id))
  const published = [...bundle.claims].sort((a, b) => a.ref.id.localeCompare(b.ref.id))
  return JSON.stringify(live) === JSON.stringify(published)
}

function buildProjection(bundle: GraphSemanticBundle): GraphProjectionSnapshot {
  const entities = new Set(bundle.entities.map(entity => `${entity.ref.id}\0${entity.ref.version}`))
  const edges: GraphSemanticEdge[] = []
  for (const assertion of bundle.openAssertions ?? []) {
    if (assertion.review.status !== 'accepted') continue
    edges.push({ id: `open-evidence:${hash(assertion.ref)}`, layer: 'semantic', kind: 'open-evidence',
      from: assertion.ref, to: { kind: 'information', id: `information:${assertion.source.captureId}`, version: assertion.source.revision } })
    for (const participant of assertion.participants)
      edges.push({ id: `open-participant:${hash([assertion.ref, participant.ref, participant.role])}`, layer: 'semantic',
        kind: 'open-participant', from: assertion.ref, to: participant.ref, role: participant.role })
  }
  for (const claim of bundle.claims) {
    for (const [role, term] of Object.entries(claim.atom.args)) {
      if (term.kind !== 'entity') continue
      if (!entities.has(`${term.ref.id}\0${term.ref.version}`))
        throw new Error('Accepted L1 Claim references a missing Entity')
      edges.push({ id: `l1-argument:${hash([claim.ref, role, term.ref])}`, layer: 'semantic', kind: 'has-argument',
        from: claim.ref, to: term.ref, role })
    }
  }
  edges.sort((a, b) => a.id.localeCompare(b.id))
  const semanticFingerprint = fingerprint(bundle)
  const manifestId = `l1-projection:${hash([GRAPH_L1_PROJECTION_VERSION, bundle.bundleId, semanticFingerprint, edges])}`
  return { manifest: { protocolVersion: MEMORY_GRAPH_PROTOCOL_VERSION, schemaVersion: 1, manifestId,
    sourceBundleId: bundle.bundleId, scope: bundle.scope, sourceRevisions: bundle.revisions,
    semanticFingerprint, builderVersion: GRAPH_L1_PROJECTION_VERSION, navigationRevision: 0,
    createdAt: Date.now(), state: 'ready' }, semanticBundle: structuredClone(bundle),
  derivedClaims: [], proofs: [], edges }
}

function fingerprint(bundle: GraphSemanticBundle): string {
  return hash(bundle)
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
