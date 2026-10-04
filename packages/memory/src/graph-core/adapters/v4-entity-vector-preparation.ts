import type { GraphScope, MemorySharePolicy, MemorySensitivity } from '@continuum-memory/contracts'
import type { MemoryEmbeddingIndex } from '../../long-term/embedding-index'
import type { V4GraphMemoryOptions } from './v4-graph-memory'
import { collectCurrentL1 } from './accepted-l1-input'
import { graphHash } from './v4-semantic-adapter'
import { createV4RelationSourceReader } from './v4-relation-sources'
import { prepareEntityVectors } from '../recall/entity-vector-preparation'
import type { EntityRetrievalTextMode } from '../projection/entity-retrieval-projection'

/** Prepare from the same retained V4/L1 contract as recall, without publishing or approving input. */
export async function prepareV4EntityVectors(options: {
  memory: V4GraphMemoryOptions
  scope: GraphScope
  sharePolicies: readonly MemorySharePolicy[]
  sensitivities: readonly MemorySensitivity[]
  index: MemoryEmbeddingIndex
  model: string
  embed: (text: string) => Promise<number[]>
  isCurrent: () => boolean
  textMode?: EntityRetrievalTextMode
  maxItems?: number
}) {
  const memory = options.memory
  if (!memory.authorizeScope(options.scope)) throw new Error('Entity preparation scope denied')
  const nativeFingerprint = graphHash(memory.acceptedBundle?.() ?? null)
  const collected = collectCurrentL1(memory, options.scope, memory.now?.() ?? Date.now())
  const bundle = collected.projection.semanticBundle
  const sourceFingerprint = graphHash(collected.source)
  const reader = createV4RelationSourceReader(memory)
  const access = { accessContextId: 'entity-preparation', authorizationVersion: 'current', scope: options.scope,
    sharePolicies: options.sharePolicies, sensitivities: options.sensitivities }
  const policyAllows = (record: { sharePolicy: MemorySharePolicy; sensitivity: MemorySensitivity }) =>
    options.sharePolicies.includes(record.sharePolicy) && options.sensitivities.includes(record.sensitivity)
  const facts = new Map(collected.inputs.map(input => [input.fact.id, input.fact]))
  const entries = bundle.claims.flatMap(claim => {
    const fact = facts.get(claim.fact.id)
    return fact && policyAllows(claim) && reader.read(claim.provenance.sources, access).ok ? [{ claim, fact }] : []
  })
  const entities = bundle.entities.filter(entity => policyAllows(entity) && reader.read(entity.provenance.sources, access).ok)
  const isCurrent = () => options.isCurrent() && memory.authorizeScope(options.scope)
    && graphHash(memory.repository.snapshot()) === sourceFingerprint
    && graphHash(memory.acceptedBundle?.() ?? null) === nativeFingerprint
  return prepareEntityVectors({ bundle: { ...bundle, entities }, entries, index: options.index,
    model: options.model, embed: options.embed, isCurrent, textMode: options.textMode ?? 'claim-fragments', maxItems: options.maxItems })
}
