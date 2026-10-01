import type { GraphScope, GraphTemporalQuery } from '@continuum-memory/contracts'
import type { GraphClaimRecord, GraphEntityRecord, GraphProjectionSnapshot } from '../domain/types'
import type { DirectSemanticOptions, SemanticResult } from './direct-semantic'
import { searchDirectSemantic } from './direct-semantic'
import { graphHash } from '../adapters/v4-semantic-adapter'
import { planL2EntityTarget } from './l2-entity-target'
import { entityClaimIndex } from '../projection/entity-claim-index'

export const ENTITY_VECTOR_POLICY = 'entity-vector-to-local-claims-v1'
export const entityVectorDocument = (entity: GraphEntityRecord) => ({
  // Separate namespace and exact identity; never reuse fact embeddings or merge equal names.
  id: `graph-entity:${graphHash([entity.scope, entity.ref, entity.provenance])}`,
  canonicalText: [entity.canonicalName, ...entity.aliases, entity.entityType].join('\n'),
})

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
  /** Wide candidates must be assessed separately before becoming evidence or traversal seeds. */
  claimCandidateMode?: 'wide' | 'threshold'
  remainingMs: number
  canReadEntity: (entity: GraphEntityRecord) => boolean
  onLocalCandidates?: (ids: readonly string[]) => void
}): Promise<SemanticResult> {
  if (!Number.isSafeInteger(input.entityLimit) || input.entityLimit < 0 || input.entityLimit > 32)
    throw new Error('Entity candidate limit must be in [0,32]')
  const started = performance.now()
  const adjacency = entityClaimIndex(input.projection)
  const eligible = new Map(input.entries.map(entry => [graphHash(entry.claim.ref), entry]))
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
  const documents = entities.map(entityVectorDocument)
  let queryEmbedding: Awaited<ReturnType<DirectSemanticOptions['embedQuery']>>
  const entityOptions = input.entitySemantic && { ...input.entitySemantic, rankOnly: true, embedQuery: async (query: string) => {
    queryEmbedding = await input.entitySemantic!.embedQuery(query); return queryEmbedding
  } }
  const entityResults = await searchDirectSemantic(input.query, documents, entityOptions, input.remainingMs)
  const byId = new Map(entities.map(entity => [entityVectorDocument(entity).id, entity]))
  const selected = entityResults.hits.slice(0, input.entityLimit)
  const catalog = entities.map(entity => ({ key: graphHash(entity.ref), names: [entity.canonicalName, ...entity.aliases] }))
  const entityTarget = planL2EntityTarget(input.query, catalog)
  const bindings = new Map(catalog.map(item => [item.key, item]))
  const local = new Map<string, typeof input.entries[number]['fact']>()
  for (const hit of selected) for (const entry of localEntries(graphHash(byId.get(hit.id)!.ref))) {
    const claimBindings = Object.values(entry.claim.atom.args).flatMap(term => {
      const binding = term.kind === 'entity' ? bindings.get(graphHash(term.ref)) : undefined
      return binding ? [binding] : []
    })
    if (entityTarget.matches(claimBindings)) local.set(entry.fact.id, entry.fact)
  }
  const scope = [ENTITY_VECTOR_POLICY, 'seed-entry:entity-vector', 'entity-read:exact-ref-adjacency',
    `entity-claim-index:${adjacency.reused ? 'reused' : 'built'}`,
    `entity-candidates:${entities.length}`, `entity-selected:${selected.length}`, `entity-local-facts:${local.size}`,
    ...entityTarget.scope, ...selected.map(hit => `entity-seed:${JSON.stringify(byId.get(hit.id)!.ref)}`),
    ...entityResults.scope.map(value => `entity-${value}`),
    ...(entityResults.hits.length > input.entityLimit ? ['entity-top-k-truncated'] : [])]
  input.onLocalCandidates?.([...local.keys()])
  if (!local.size) return { hits: [], competition: [], scope: [...scope, 'no-local-claim-candidates'], incomplete: entityResults.incomplete }
  const normalize = (text: string) => text.normalize('NFKC').trim().toLowerCase()
  const entityOnly = selected.some(hit => {
    const entity = byId.get(hit.id)!
    return [entity.canonicalName, ...entity.aliases].some(name => normalize(name) === normalize(input.query))
  })
  if (entityOnly) {
    // An explicit whole-entity query asks for its local facts, not a semantic comparison of a name with a sentence.
    const hits = [...local.keys()].sort().map(id => ({ id, score: 1 }))
    if (selected.some(hit => !input.canReadEntity(byId.get(hit.id)!))) throw new Error('Entity source changed during recall')
    return { hits, competition: [], incomplete: entityResults.incomplete, scope: [...scope, 'claim-selection:entity-adjacency'] }
  }
  // Refine only the selected entities' adjacent facts. This is not a second global Claim search.
  const baseClaimOptions = input.claimSemantic && input.claimCandidateMode === 'wide'
    ? { ...input.claimSemantic, rankOnly: true } : input.claimSemantic
  const claimOptions = baseClaimOptions && queryEmbedding?.model === baseClaimOptions.model
    && input.entitySemantic?.dimensions === baseClaimOptions.dimensions
    ? { ...baseClaimOptions, embedQuery: async () => queryEmbedding } : baseClaimOptions
  const claims = await searchDirectSemantic(input.query, [...local.values()], claimOptions,
    input.remainingMs - (performance.now() - started))
  if (selected.some(hit => !input.canReadEntity(byId.get(hit.id)!))) throw new Error('Entity source changed during recall')
  return { ...claims, incomplete: entityResults.incomplete || claims.incomplete,
    scope: [...scope, 'claim-selection:local-vector', `claim-candidates:${input.claimCandidateMode ?? 'threshold'}`, ...claims.scope] }
}
