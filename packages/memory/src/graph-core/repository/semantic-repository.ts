import { createHash } from 'node:crypto'
import type { GraphResult, GraphSourceRef } from '@continuum-memory/contracts'
import type { MemoryV4Repository } from '../../v4/repository/memory-v4-repository'
import type { GraphL1Store } from '../../long-term/graph-l1-write'
import type { CaptureRepository } from '../../long-term/capture-repository'
import type { GraphPredicateRegistry } from '../../long-term/graph-identity-normalization'
import type { GraphClaimRecord, GraphEntityRecord, GraphGroundTerm, GraphSemanticBundle } from '../domain/types'
import type { GraphSemanticWritePort } from '../ports/graph-ports'
import { projectCapturedInformation } from './captured-information'

export interface GraphSemanticPersistence {
  load: () => string | undefined
  /** Atomically replaces the complete encrypted payload. */
  save: (payload: string) => void
}

export interface GraphSemanticRepository extends GraphSemanticWritePort {
  snapshot: () => GraphSemanticBundle | undefined
  /** Rebuilds accepted Claims and exact active capture information; removes revoked sources. */
  syncFromClaims: (l1: GraphL1Store, v4: MemoryV4Repository, registry: GraphPredicateRegistry,
    scope: GraphSemanticBundle['scope']) => Promise<GraphResult<{ bundleId: string }>>
}

/** CAS publication of immutable, complete bundles. The V4 repository remains the fact authority. */
export function createGraphSemanticRepository(persistence: GraphSemanticPersistence,
  v4: MemoryV4Repository, captures?: CaptureRepository): GraphSemanticRepository {
  const raw = persistence.load()
  let current = raw ? JSON.parse(raw) as GraphSemanticBundle : undefined
  if (current && (current.schemaVersion !== 1 || !current.bundleId || !Array.isArray(current.claims)))
    throw new Error('Invalid graph semantic bundle')
  const operations = new Map<string, string>()
  let writing = false
  const publish: GraphSemanticWritePort['publish'] = async (request) => {
    if (!request.operationId.trim()) return failure('invalid-request', 'Empty graph operation ID')
    if (writing) return failure('not-ready', 'Graph semantic publication in progress')
    if (request.expectedBundleId !== (current?.bundleId ?? null))
      return failure('version-mismatch', 'Graph semantic bundle changed')
    const serialized = JSON.stringify(request.bundle)
    const previous = operations.get(request.operationId)
    if (previous && previous !== serialized)
      return failure('invalid-request', 'Graph operation ID reused with different content')
    if (!validBundle(request.bundle, v4, captures))
      return failure('source-unavailable', 'Graph Claim or source information lacks active exact evidence')
    writing = true
    try {
      persistence.save(serialized)
      current = structuredClone(request.bundle)
      operations.set(request.operationId, serialized)
      return { ok: true, value: { bundleId: request.bundle.bundleId } }
    }
    catch {
      return failure('not-ready', 'Graph semantic persistence failed')
    }
    finally { writing = false }
  }
  return {
    publish,
    snapshot: () => current ? structuredClone(current) : undefined,
    async syncFromClaims(l1, repository, registry, scope) {
      const next = buildBundle(l1, repository, registry, scope, current, captures)
      if (current && sameContents(current, next))
        return { ok: true, value: { bundleId: current.bundleId } }
      return publish({ operationId: `graph-sync:${next.bundleId}`,
        expectedBundleId: current?.bundleId ?? null, bundle: next })
    },
  }
}

function buildBundle(l1: GraphL1Store, v4: MemoryV4Repository, registry: GraphPredicateRegistry,
  scope: GraphSemanticBundle['scope'], previous?: GraphSemanticBundle, captures?: CaptureRepository): GraphSemanticBundle {
  const snapshot = v4.snapshot()
  const claims = l1.claims().filter(claim => sameScope(claim.scope, scope) && exactClaimAvailable(claim, snapshot))
    .sort((a, b) => a.ref.id.localeCompare(b.ref.id)) as GraphClaimRecord[]
  const contexts = l1.contexts().filter(context => claims.some(claim => claim.context.id === context.ref.id))
    .sort((a, b) => a.ref.id.localeCompare(b.ref.id))
  const taskById = new Map(l1.tasks().map(task => [task.id, task]))
  const entities = new Map<string, GraphEntityRecord>()
  for (const claim of claims) {
    const catalog = taskById.get(claim.ref.id)?.entities ?? []
    for (const term of Object.values(claim.atom.args)) {
      if (term.kind !== 'entity') continue
      const source = catalog.find(entity => entity.ref.id === term.ref.id && entity.ref.version === term.ref.version)
      if (!source) throw new Error('Accepted Claim lost its resolved Entity record')
      if (!sameScope(source.scope, claim.scope)) throw new Error('Resolved Entity scope changed')
      const reviewedSource = source as Partial<GraphEntityRecord>
      const sourceReview = reviewedSource.review
      const completeReview = sourceReview?.status === 'accepted'
        && Number.isFinite(sourceReview.reviewedAt) && !!sourceReview.reviewer?.trim()
        ? sourceReview : undefined
      const key = `${term.ref.id}:${term.ref.version}`
      const existing = entities.get(key)
      entities.set(key, { ref: term.ref, scope: claim.scope, entityType: source.entityType,
        canonicalName: source.canonicalName, aliases: source.aliases,
        transactionTime: existing?.transactionTime ?? reviewedSource.transactionTime ?? claim.transactionTime,
        provenance: existing?.provenance ?? reviewedSource.provenance ?? claim.provenance,
        review: existing?.review ?? completeReview ?? claim.review,
        sensitivity: stricter(stricter(existing?.sensitivity, reviewedSource.sensitivity ?? claim.sensitivity,
          ['normal', 'private', 'secret'] as const), claim.sensitivity, ['normal', 'private', 'secret'] as const),
        sharePolicy: stricter(stricter(existing?.sharePolicy, reviewedSource.sharePolicy ?? claim.sharePolicy,
          ['allow-remote', 'ask', 'local-only'] as const), claim.sharePolicy, ['allow-remote', 'ask', 'local-only'] as const) })
    }
  }
  const predicates = registry.registrations.filter(item => claims.some(claim => claim.atom.predicate === item.spec.name))
    .map(item => item.spec).sort((a, b) => a.name.localeCompare(b.name))
  const revisions = { v4: snapshot.revision, semantics: (previous?.revisions.semantics ?? 0) + 1,
    predicates: 1, rules: 0, aliases: 0 }
  const content = { scope, information: captures ? projectCapturedInformation(captures.snapshot(), scope) : [],
    entities: [...entities.values()].sort((a, b) => a.ref.id.localeCompare(b.ref.id)),
    aliases: [], predicates, contexts, claims, statements: [], rules: [] } as const
  const bundleId = `graph-semantic:${hash([content, revisions])}`
  return { schemaVersion: 1, bundleId, revisions, ...content }
}

function sameContents(a: GraphSemanticBundle, b: GraphSemanticBundle): boolean {
  return JSON.stringify([a.scope, a.information ?? [], a.entities, a.aliases, a.predicates, a.contexts, a.claims, a.statements, a.rules,
    a.revisions.v4]) === JSON.stringify([b.scope, b.information ?? [], b.entities, b.aliases, b.predicates, b.contexts, b.claims,
    b.statements, b.rules, b.revisions.v4])
}

function validBundle(bundle: GraphSemanticBundle, v4: MemoryV4Repository, captures?: CaptureRepository): boolean {
  if (bundle.schemaVersion !== 1 || !bundle.bundleId || !bundle.scope.ownerId || !bundle.scope.agentId
    || !Array.isArray(bundle.claims) || !Array.isArray(bundle.contexts) || !Array.isArray(bundle.entities)
    || !Array.isArray(bundle.predicates) || !Array.isArray(bundle.aliases)
    || !Array.isArray(bundle.statements) || !Array.isArray(bundle.rules)
    || (captures
      ? JSON.stringify(bundle.information ?? []) !== JSON.stringify(projectCapturedInformation(captures.snapshot(), bundle.scope))
      : (bundle.information?.length ?? 0) > 0)) return false
  const snapshot = v4.snapshot()
  if (bundle.revisions.v4 !== snapshot.revision) return false
  const contexts = new Set(bundle.contexts.map(record => `${record.ref.id}:${record.ref.version}`))
  const entities = new Set(bundle.entities.map(record => `${record.ref.id}:${record.ref.version}`))
  const predicates = new Set(bundle.predicates.map(record => record.name))
  return bundle.claims.every(claim => sameScope(claim.scope, bundle.scope)
    && claim.review.status === 'accepted' && contexts.has(`${claim.context.id}:${claim.context.version}`)
    && predicates.has(claim.atom.predicate) && (Object.values(claim.atom.args) as GraphGroundTerm[]).every(term => term.kind !== 'entity'
      || entities.has(`${term.ref.id}:${term.ref.version}`)) && exactClaimAvailable(claim, snapshot))
}

export function exactClaimAvailable(claim: GraphClaimRecord,
  snapshot: ReturnType<MemoryV4Repository['snapshot']>): boolean {
  const fact = snapshot.facts.find(item => item.id === claim.fact.id)
  const version = snapshot.factVersions.find(item => item.factId === claim.fact.id
    && item.version === claim.fact.version)
  if (!fact || fact.status !== 'active' || fact.invalidatedAt !== undefined || !version
    || version.transactionClosedAt !== undefined || !claim.provenance.sources.length
    || fact.predicate !== claim.atom.predicate || fact.polarity !== claim.polarity
    || fact.modality !== claim.modality || version.predicate !== fact.predicate
    || version.polarity !== fact.polarity || version.modality !== fact.modality
    || version.subjectId !== fact.subjectId || JSON.stringify(version.object) !== JSON.stringify(fact.object)
    || version.validFrom !== fact.validFrom || version.validTo !== fact.validTo
    || snapshot.factVersions.some(item => item.factId === fact.id && item.version > version.version)) return false
  const terms = Object.values(claim.atom.args) as GraphGroundTerm[]
  if (!terms.some(term => term.kind === 'entity' && term.ref.id === fact.subjectId)
    || !terms.some(term => term.kind === fact.objectType && (term.kind === 'entity'
      ? term.ref.id === fact.object : term.value === fact.normalizedValue))) return false
  if (claim.validTime.kind === 'unknown' ? fact.validFrom !== undefined
    : claim.validTime.from !== fact.validFrom || claim.validTime.to !== (fact.validTo ?? null)) return false
  return claim.provenance.sources.every(source => sourceAvailable(source, claim.fact.id, snapshot))
}

function sourceAvailable(source: GraphSourceRef, factId: string,
  snapshot: ReturnType<MemoryV4Repository['snapshot']>): boolean {
  const episode = snapshot.episodes.find(item => item.id === source.episodeId)
  return !!episode && episode.contentState === 'available' && !!episode.content
    && episode.contentHash === source.contentHash
    && hash(episode.content) === source.contentHash
    && snapshot.evidenceLinks.some(link => link.factId === factId && link.episodeId === episode.id && link.active)
    && (source.locator.kind !== 'text-span' || source.locator.start >= 0
      && source.locator.end <= episode.content.length && source.locator.start < source.locator.end)
}

function sameScope(a: GraphSemanticBundle['scope'], b: GraphSemanticBundle['scope']): boolean {
  return a.ownerId === b.ownerId && a.agentId === b.agentId && a.sessionId === b.sessionId
}

function stricter<T extends string>(a: T | undefined, b: T, order: readonly T[]): T {
  return a && order.indexOf(a) > order.indexOf(b) ? a : b
}

function hash(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
}

function failure(code: 'invalid-request' | 'not-ready' | 'version-mismatch' | 'source-unavailable', message: string): GraphResult<never> {
  return { ok: false, error: { code, message } }
}
