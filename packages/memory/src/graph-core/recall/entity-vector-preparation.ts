import type { GraphSemanticBundle } from '../domain/types'
import type { MemoryEmbeddingIndex } from '../../long-term/embedding-index'
import { buildEntityRetrievalProjection, type EntityRetrievalEntry, type EntityRetrievalTextMode } from '../projection/entity-retrieval-projection'

/** Local, rebuildable cache preparation outside the recall budget; no model downloads or identity changes. */
export async function prepareEntityVectors(options: {
  bundle: GraphSemanticBundle
  /** Retained, source-checked exact Claim/Fact pairs. No extraction or publication here. */
  entries?: readonly EntityRetrievalEntry[]
  textMode?: EntityRetrievalTextMode
  index: MemoryEmbeddingIndex
  model: string
  embed: (text: string) => Promise<number[]>
  isCurrent: () => boolean
  maxItems?: number
}) {
  const projected = buildEntityRetrievalProjection({ entities: options.bundle.entities, entries: options.entries ?? [],
    mode: options.textMode ?? 'name-only' })
  const documents = projected.documents
  if (!Number.isSafeInteger(options.maxItems ?? 128) || (options.maxItems ?? 128) < 0) throw new Error('Invalid entity preparation limit')
  if (!options.isCurrent()) throw new Error('Entity publication changed before vector preparation')
  options.index.reconcileMemoryIds(new Set(documents.map(d => d.id)))
  const pending = documents.filter(d => !options.index.get(d.id, options.model, d.canonicalText))
  let prepared = 0
  for (const doc of pending.slice(0, options.maxItems ?? 128)) {
    const vector = await options.embed(doc.canonicalText)
    if (!options.isCurrent()) {
      options.index.removeMemoryIds(documents.map(d => d.id))
      throw new Error('Entity publication changed during vector preparation')
    }
    options.index.putBatch([{ memoryId: doc.id, model: options.model, content: doc.canonicalText, vector }])
    prepared++
  }
  return { total: documents.length, prepared, pending: pending.length - prepared,
    textMode: options.textMode ?? 'name-only', omittedFragments: projected.omittedFragments, truncatedClaims: projected.truncatedClaims }
}
