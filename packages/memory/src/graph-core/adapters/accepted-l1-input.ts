import type { GraphScope, GraphTemporalQuery } from '@continuum-memory/contracts'
import type { GraphClaimRecord, GraphProjectionSnapshot, GraphSemanticBundle } from '../domain/types'
import type { V4GraphMemoryOptions } from './v4-graph-memory'
import { collectV4RecallInputs, type V4RecallInput } from './v4-recall-input'
import { graphHash, projectV4ScalarInputs, sourceHash } from './v4-semantic-adapter'
import { exactClaimAvailable } from '../repository/semantic-repository'
import type { L2EntityBinding } from '../recall/l2-entity-target'

/** Retrieval permission is separate from extraction, semantic acceptance and proactive use. */
export function selectRetrievableGraphBundle(bundle: GraphSemanticBundle | undefined,
  tasks: readonly { id: string; state: string; review: { retrieval: { retain: boolean } } }[]): GraphSemanticBundle | undefined {
  if (!bundle) return undefined
  const retained = new Set(tasks.filter(task => task.state === 'published' && task.review.retrieval.retain).map(task => task.id))
  return { ...structuredClone(bundle), claims: bundle.claims.filter(claim => retained.has(claim.ref.id)).map(c => structuredClone(c)) }
}

type Options = Pick<V4GraphMemoryOptions, 'repository' | 'canRead' | 'acceptedBundle' | 'includeOwnedSessions'>
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const scopeContains = (query: GraphScope, record: GraphScope, sessions: boolean) =>
  query.ownerId === record.ownerId && query.agentId === record.agentId
  && (query.sessionId === record.sessionId || (sessions && query.sessionId === undefined))

/** Build a query-independent read projection; preserve authoritative Claim IDs and versions. */
export function collectCurrentL1(options: Options, scope: GraphScope, at: number,
  visibleFacts?: readonly { id: string; version: number }[]) {
  const source = options.repository.snapshot()
  const gathered = collectV4RecallInputs(options.repository, { scope, expectedRevision: source.revision,
    includeOwnedSessions: options.includeOwnedSessions, now: at, canRead: options.canRead })
  // Graph-writer facts must never bypass retrieval consent or an unavailable native publication.
  const visible = (id: string, version: number) => visibleFacts === undefined || visibleFacts.some(ref => ref.id === id && ref.version === version)
  const scalarInputs = gathered.inputs.filter(input => !input.fact.metadata?.graphTaskId && visible(input.fact.id, input.version.version))
  const base = projectV4ScalarInputs(scalarInputs, scope, source.revision)
  const bundle = options.acceptedBundle?.()
  const accepted: { input: V4RecallInput; claim: GraphClaimRecord }[] = []
  if (bundle && bundle.revisions.v4 === source.revision && scopeContains(scope, bundle.scope, !!options.includeOwnedSessions)) {
    if (bundle.claims.length > 10000 || bundle.entities.length > 20000) throw new Error('Accepted L1 scan limit exceeded')
    for (const claim of bundle.claims) {
      if (!visible(claim.fact.id, claim.fact.version)) continue
      const fact = source.facts.find(f => f.id === claim.fact.id)
      const version = source.factVersions.find(v => v.factId === claim.fact.id && v.version === claim.fact.version)
      const context = bundle.contexts.find(c => same(c.ref, claim.context))
      const readable = (record: { sensitivity: string; sharePolicy: string }) =>
        ['normal', 'private', 'secret'].indexOf(claim.sensitivity) >= ['normal', 'private', 'secret'].indexOf(record.sensitivity)
        && ['allow-remote', 'ask', 'local-only'].indexOf(claim.sharePolicy) >= ['allow-remote', 'ask', 'local-only'].indexOf(record.sharePolicy)
      if (!fact || !version || !context || !exactClaimAvailable(claim, source)
        || !same(fact.scope, claim.scope) || !same(context.scope, claim.scope)
        || !scopeContains(scope, fact.scope, !!options.includeOwnedSessions)
        || claim.review.status !== 'accepted' || context.review.status !== 'accepted'
        || claim.review.reviewedAt > at || claim.transactionTime.recordedAt > at || claim.transactionTime.closedAt !== null
        || fact.verificationState !== 'verified' || fact.updatedAt > at
        || (fact.expiresAt !== undefined && fact.expiresAt <= at) || !options.canRead(structuredClone(fact)) || !readable(fact)) continue
      const fields = ['subjectId', 'predicate', 'object', 'objectType', 'normalizedValue', 'canonicalText',
        'polarity', 'modality', 'condition', 'status', 'validFrom', 'validTo', 'evidenceLinkIds', 'sourceStatement'] as const
      if (version.recordedAt > at || fields.some(key => !same(fact[key], version[key]))) continue
      if (!bundle.predicates.some(p => p.name === claim.atom.predicate)
        || Object.values(claim.atom.args).some(term => term.kind === 'entity' && !bundle.entities.some(entity =>
          same(entity.ref, term.ref) && same(entity.scope, claim.scope) && entity.review.status === 'accepted'))) continue
      const sources: V4RecallInput['sources'] = []
      for (const ref of claim.provenance.sources) {
        const episode = source.episodes.find(e => e.id === ref.episodeId)
        const link = source.evidenceLinks.find(l => fact.evidenceLinkIds.includes(l.id) && l.factId === fact.id
          && l.episodeId === ref.episodeId && l.active && l.invalidatedAt === undefined && l.createdAt <= at)
        if (!episode || !link || episode.deletedAt !== undefined || episode.recordedAt > at
          || episode.contentState !== 'available' || !episode.content || sourceHash(episode.content) !== ref.contentHash
          || !scopeContains(fact.scope, episode.scope, fact.scope.sessionId === undefined)
          || !options.canRead(structuredClone(episode)) || !readable(episode)) break
        if (ref.locator.kind === 'text-span') {
          const { start, end, unit } = ref.locator
          if (unit !== 'utf16' || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
            || start < 0 || end <= start || end > episode.content.length
            || [start, end].some(i => /[\uD800-\uDBFF]/.test(episode.content![i - 1] ?? '')
              && /[\uDC00-\uDFFF]/.test(episode.content![i] ?? ''))) break
        } else if (ref.locator.kind !== 'whole-content') break
        sources.push({ link, episode })
      }
      if (sources.length !== claim.provenance.sources.length
        || !sources.some(s => s.link.role === 'supports' && s.link.strength === 'direct')) continue
      accepted.push({ input: { fact, version, sources }, claim })
    }
  }
  const nativeFacts = new Set(accepted.map(a => a.input.fact.id))
  const inputs = [...scalarInputs.filter(i => !nativeFacts.has(i.fact.id)), ...accepted.map(a => a.input)]
  let projection = base
  if (accepted.length && bundle) {
    const claims = [...base.semanticBundle.claims.filter(c => !nativeFacts.has(c.fact.id)), ...accepted.map(a => a.claim)]
    const contexts = bundle.contexts.filter(c => accepted.some(a => same(a.claim.context, c.ref)))
    const entities = bundle.entities.filter(e => accepted.some(a => Object.values(a.claim.atom.args).some(t => t.kind === 'entity' && same(t.ref, e.ref))))
    const predicates = bundle.predicates.filter(p => accepted.some(a => a.claim.atom.predicate === p.name))
    const unique = <T>(a: readonly T[], b: readonly T[], key: (v: T) => string): T[] => {
      const map = new Map(a.map(v => [key(v), v]))
      for (const item of b) { const old = map.get(key(item)); if (old && !same(old, item)) throw new Error('Conflicting exact L1 records'); map.set(key(item), item) }
      return [...map.values()]
    }
    const contents = { ...base.semanticBundle, claims, entities,
      contexts: unique(base.semanticBundle.contexts, contexts, c => graphHash(c.ref)),
      predicates: unique(base.semanticBundle.predicates, predicates, p => p.name) }
    const fingerprint = graphHash([contents, bundle.bundleId])
    const bundleId = `combined-l1:${fingerprint}`
    projection = { ...base, manifest: { ...base.manifest, manifestId: bundleId, sourceBundleId: bundleId, semanticFingerprint: fingerprint },
      semanticBundle: { ...contents, bundleId } }
  }
  if (!same(options.repository.snapshot(), source) || !same(options.acceptedBundle?.(), bundle))
    throw new Error('L1 input changed during collection')
  return { source, inputs, projection, rejected: gathered.rejected.filter(r => !nativeFacts.has(r.factId)) }
}

export function claimMatchesTime(claim: GraphClaimRecord, temporal: GraphTemporalQuery, includeUnknown = false): boolean {
  const time = claim.validTime, valid = temporal.valid
  if (claim.review.status !== 'accepted' || claim.review.reviewedAt > temporal.knownAt
    || claim.transactionTime.recordedAt > temporal.knownAt) return false
  if (time.kind === 'unknown') return includeUnknown
  return valid.kind === 'at' ? (time.from === null || time.from <= valid.at) && (time.to === null || valid.at < time.to)
    : (time.from === null || time.from < valid.to) && (time.to === null || valid.from < time.to)
}

/** Names/aliases help locate Claims; identity equality always requires an exact Entity ref. */
export function entityCandidateText(claim: GraphClaimRecord, projection: GraphProjectionSnapshot,
  sharePolicies: readonly string[], sensitivities: readonly string[]): string {
  return entityCandidateNames(claim, projection, sharePolicies, sensitivities).join(' ')
}

export function entityCandidateNames(claim: GraphClaimRecord, projection: GraphProjectionSnapshot,
  sharePolicies: readonly string[], sensitivities: readonly string[]): string[] {
  return Object.values(claim.atom.args).flatMap(term => {
    if (term.kind !== 'entity') return []
    const entity = projection.semanticBundle.entities.find(e => same(e.ref, term.ref))
    return entity && sharePolicies.includes(entity.sharePolicy) && sensitivities.includes(entity.sensitivity)
      ? [entity.canonicalName, ...entity.aliases] : []
  })
}

/** Called only for authorized retained Claims; valid-time exclusion must not erase their known identity. */
export function entityCandidateBindings(claim: GraphClaimRecord, projection: GraphProjectionSnapshot,
  sharePolicies: readonly string[], sensitivities: readonly string[], knownAt: number): L2EntityBinding[] {
  return Object.values(claim.atom.args).flatMap(term => {
    if (term.kind !== 'entity') return []
    const entity = projection.semanticBundle.entities.find(e => same(e.ref, term.ref))
    if (!entity || !same(entity.scope, claim.scope) || !sharePolicies.includes(entity.sharePolicy)
      || !sensitivities.includes(entity.sensitivity) || entity.review.status !== 'accepted'
      || entity.review.reviewedAt > knownAt || entity.transactionTime.recordedAt > knownAt
      || entity.transactionTime.closedAt !== null) return []
    return [{ key: graphHash(entity.ref), names: [entity.canonicalName, ...entity.aliases] }]
  })
}
