import type { GraphScope, GraphTemporalQuery } from '@continuum-memory/contracts'
import type { GraphClaimRecord, GraphEntityRecord, GraphProjectionSnapshot } from '../domain/types'
import type { DirectSemanticOptions, SemanticResult } from './direct-semantic'
import { searchDirectSemantic } from './direct-semantic'
import { graphHash } from '../adapters/v4-semantic-adapter'
import { planL2EntityTarget } from './l2-entity-target'
import { entityClaimIndex } from '../projection/entity-claim-index'
import { buildEntityRetrievalProjection, ENTITY_RETRIEVAL_TEXT_POLICY, type EntityRetrievalTextMode } from '../projection/entity-retrieval-projection'
import { selectEntityNavigationCandidates, type EntityCandidateSelectionOptions } from './entity-candidate-selection'
import { recallQueryVariants } from './query-expansion'
export { entityVectorDocument } from '../projection/entity-retrieval-projection'

export const ENTITY_VECTOR_POLICY = 'entity-vector-to-local-claims-v1'

/** Entity lookup precedes local Claim ranking. Inputs must already be source/time/access checked. */
export async function searchEntityVectorSeeds(input: {
  query: string
  projection: GraphProjectionSnapshot
  entries: readonly { claim: GraphClaimRecord; fact: { id: string; canonicalText: string } }[]
  scope: GraphScope
  temporal: GraphTemporalQuery
  sharePolicies: readonly string[]
  sensitivities: readonly string[]
  entitySemantic: DirectSemanticOptions | undefined
  claimSemantic: DirectSemanticOptions | undefined
  entityLimit: number
  textMode?: EntityRetrievalTextMode
  entitySelection?: EntityCandidateSelectionOptions
  /** Wide candidates must be assessed separately before becoming evidence or traversal seeds. */
  claimCandidateMode?: 'wide' | 'threshold'
  remainingMs: number
  canReadEntity: (entity: GraphEntityRecord) => boolean
  /** Required in fragment mode; also rechecked after asynchronous vector lookup. */
  canReadClaim?: (claim: GraphClaimRecord) => boolean
  onLocalCandidates?: (ids: readonly string[]) => void
}): Promise<SemanticResult> {
  if (!Number.isSafeInteger(input.entityLimit) || input.entityLimit < 0 || input.entityLimit > 32)
    throw new Error('Entity candidate limit must be in [0,32]')
  const started = performance.now()
  const textMode = input.textMode ?? 'name-only'
  if (textMode === 'claim-fragments' && !input.canReadClaim) throw new Error('Fragment navigation requires a live Claim source reader')
  const adjacency = entityClaimIndex(input.projection)
  const entries = input.entries.filter(({ claim }) => textMode === 'name-only' || (
    claim.scope.ownerId === input.scope.ownerId && claim.scope.agentId === input.scope.agentId
    && (input.scope.sessionId === undefined || claim.scope.sessionId === input.scope.sessionId)
    && input.sharePolicies.includes(claim.sharePolicy) && input.sensitivities.includes(claim.sensitivity)
    && claim.review.status === 'accepted' && claim.review.reviewedAt <= input.temporal.knownAt
    && claim.transactionTime.recordedAt <= input.temporal.knownAt && claim.transactionTime.closedAt === null
    && input.canReadClaim!(claim)))
  const eligible = new Map(entries.map(entry => [graphHash(entry.claim.ref), entry]))
  const localEntries = (entityKey: string) => (adjacency.index.get(entityKey) ?? []).flatMap(key => {
    const entry = eligible.get(key); return entry ? [entry] : []
  })
  const entities = input.projection.semanticBundle.entities.filter(entity =>
    localEntries(graphHash(entity.ref)).length > 0 && entity.scope.ownerId === input.scope.ownerId && entity.scope.agentId === input.scope.agentId
    && (input.scope.sessionId === undefined || entity.scope.sessionId === input.scope.sessionId)
    && input.sharePolicies.includes(entity.sharePolicy) && input.sensitivities.includes(entity.sensitivity)
    && entity.review.status === 'accepted' && entity.review.reviewedAt <= input.temporal.knownAt
    && entity.transactionTime.recordedAt <= input.temporal.knownAt && entity.transactionTime.closedAt === null
    && input.canReadEntity(entity))
  const catalog = entities.map(entity => ({ key: graphHash(entity.ref), names: [entity.canonicalName, ...entity.aliases] }))
  // A removable courtesy prefix must not hide an explicitly reviewed "我" alias.
  // Protect all known names and literals; identity still comes only from exact Entity refs.
  const targetQuery = input.entitySemantic?.queryExpansion
    ? recallQueryVariants(input.query, [...catalog.flatMap(e => e.names), ...(input.entitySemantic.protectedQueryTerms ?? [])]).at(-1)!
    : input.query
  const entityTarget = planL2EntityTarget(targetQuery, catalog)
  const bindings = new Map(catalog.map(item => [item.key, item]))
  const targetEntries = entries.filter(entry => entityTarget.matches(Object.values(entry.claim.atom.args).flatMap(term => {
    const binding = term.kind === 'entity' ? bindings.get(graphHash(term.ref)) : undefined
    return binding ? [binding] : []
  })))
  const targetClaims = new Set(targetEntries.map(entry => graphHash(entry.claim.ref)))
  // A high-scoring unrelated fragment must not consume an entity slot before identity checks.
  const targetEntities = entities.filter(entity => localEntries(graphHash(entity.ref)).some(entry => targetClaims.has(graphHash(entry.claim.ref))))
  const projected = buildEntityRetrievalProjection({ entities: targetEntities, entries: targetEntries, mode: textMode })
  const documents = projected.documents
  const checkNavigationLive = () => {
    if (entities.some(entity => !input.canReadEntity(entity))
      || (textMode === 'claim-fragments' && entries.some(entry => !input.canReadClaim!(entry.claim))))
      throw new Error('Entity navigation source or permission changed during recall')
  }
  const queryEmbeddings = new Map<string, Awaited<ReturnType<DirectSemanticOptions['embedQuery']>>>()
  const entityOptions = input.entitySemantic && { ...input.entitySemantic, rankOnly: true, embedQuery: async (query: string) => {
    const embedded = await input.entitySemantic!.embedQuery(query); queryEmbeddings.set(query, embedded); return embedded
  } }
  const entityResults = await searchDirectSemantic(input.query, documents, entityOptions,
    input.remainingMs - (performance.now() - started))
  checkNavigationLive()
  const byRef = new Map(entities.map(entity => [graphHash(entity.ref), entity]))
  const byDocument = new Map(documents.map(document => [document.id, document]))
  const navigation = await selectEntityNavigationCandidates({ query: input.query, documents, hits: entityResults.hits,
    finalLimit: input.entityLimit, remainingMs: input.remainingMs - (performance.now() - started), options: input.entitySelection })
  const selected = navigation.selected
  const byId = byRef
  const incomplete = entityResults.incomplete || projected.incomplete || navigation.truncated
  checkNavigationLive()
  const local = new Map<string, typeof input.entries[number]['fact']>()
  for (const hit of selected) for (const entry of localEntries(graphHash(byId.get(hit.id)!.ref))) {
    if (targetClaims.has(graphHash(entry.claim.ref))) local.set(entry.fact.id, entry.fact)
  }
  const selectedIds = new Set(selected.map(hit => hit.id))
  const fragmentHints = new Map<string, number>()
  for (const hit of entityResults.hits) {
    const document = byDocument.get(hit.id)!
    if (!document.claimRef || !document.factRef || !selectedIds.has(graphHash(document.entityRef))
      || !targetClaims.has(graphHash(document.claimRef)) || !local.has(document.factRef.id)) continue
    fragmentHints.set(document.factRef.id, Math.max(fragmentHints.get(document.factRef.id) ?? -Infinity, hit.score))
  }
  // Preserve real Claim scores and their admission threshold. Hints only break exact score ties.
  const compareHints = (a: { id: string; score: number }, b: { id: string; score: number }) =>
    b.score - a.score || (fragmentHints.get(b.id) ?? -2) - (fragmentHints.get(a.id) ?? -2) || a.id.localeCompare(b.id)
  const scope = [ENTITY_VECTOR_POLICY, 'seed-entry:entity-vector', 'entity-read:exact-ref-adjacency',
    `entity-text-mode:${textMode}`, ...(textMode === 'claim-fragments' ? [ENTITY_RETRIEVAL_TEXT_POLICY] : []),
    `entity-documents:${documents.length}`, ...navigation.scope,
    'entity-target-filter:before-top-k', `entity-target-rejected-claims:${entries.length - targetEntries.length}`,
    `entity-target-rejected-entities:${entities.length - targetEntities.length}`,
    `entity-omitted-fragments:${projected.omittedFragments}`, `entity-truncated-claims:${projected.truncatedClaims}`,
    ...(projected.incomplete ? ['entity-fragments-truncated'] : []),
    `entity-claim-index:${adjacency.reused ? 'reused' : 'built'}`,
    `entity-candidates:${entities.length}`, `entity-selected:${selected.length}`, `entity-local-facts:${local.size}`,
    `entity-fragment-local-hints:${fragmentHints.size}`, 'claim-navigation-hints:tie-break-only',
    ...entityTarget.scope, ...selected.map(hit => `entity-seed:${JSON.stringify(byId.get(hit.id)!.ref)}`),
    ...selected.flatMap(hit => hit.documentIds.map(id => {
      const document = byDocument.get(id)!
      return `entity-document-hit:${JSON.stringify({ id, entityRef: document.entityRef, claimRef: document.claimRef })}`
    })),
    ...entityResults.scope.map(value => `entity-${value}`),
    ...(navigation.total > input.entityLimit ? ['entity-top-k-truncated'] : [])]
  input.onLocalCandidates?.([...local.keys()])
  if (!local.size) return { hits: [], competition: [], scope: [...scope, 'no-local-claim-candidates'], incomplete }
  const normalize = (text: string) => text.normalize('NFKC').trim().toLowerCase()
  const entityOnly = selected.some(hit => {
    const entity = byId.get(hit.id)!
    return [entity.canonicalName, ...entity.aliases].some(name => normalize(name) === normalize(input.query))
  })
  if (entityOnly) {
    // An explicit whole-entity query asks for its local facts, not a semantic comparison of a name with a sentence.
    const hits = [...local.keys()].map(id => ({ id, score: 1 })).sort(compareHints)
    checkNavigationLive()
    return { hits, competition: [], incomplete, scope: [...scope, 'claim-selection:entity-adjacency'] }
  }
  // Refine only the selected entities' adjacent facts. This is not a second global Claim search.
  const baseClaimOptions = input.claimSemantic && input.claimCandidateMode === 'wide'
    ? { ...input.claimSemantic, rankOnly: true } : input.claimSemantic
  const claimOptions = baseClaimOptions && input.entitySemantic?.model === baseClaimOptions.model
    && input.entitySemantic?.dimensions === baseClaimOptions.dimensions
    ? { ...baseClaimOptions, embedQuery: async (query: string) => queryEmbeddings.get(query) ?? baseClaimOptions.embedQuery(query) } : baseClaimOptions
  const claims = await searchDirectSemantic(input.query, [...local.values()], claimOptions,
    input.remainingMs - (performance.now() - started))
  checkNavigationLive()
  return { ...claims, hits: [...claims.hits].sort(compareHints), incomplete: incomplete || claims.incomplete,
    scope: [...scope, 'claim-selection:local-vector', `claim-candidates:${input.claimCandidateMode ?? 'threshold'}`, ...claims.scope] }
}
