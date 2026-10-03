import type { GraphSemanticBundle } from '../domain/types'
import type { MemoryEmbeddingIndex } from '../../long-term/embedding-index'
import { entityVectorDocument } from './entity-vector-seeds'

/** Local, rebuildable cache preparation outside the recall budget; no model downloads or identity changes. */
export async function prepareEntityVectors(options: {
  bundle: GraphSemanticBundle
  index: MemoryEmbeddingIndex
  model: string
  embed: (text: string) => Promise<number[]>
  isCurrent: () => boolean
  maxItems?: number
}) {
  const documents = options.bundle.entities.filter(e => e.review.status === 'accepted' && e.transactionTime.closedAt === null)
    .map(entityVectorDocument)
  if (!options.isCurrent()) throw new Error('Entity publication changed before vector preparation')
  options.index.reconcileMemoryIds(new Set(documents.map(d => d.id)))
  const pending = documents.filter(d => !options.index.get(d.id, options.model, d.canonicalText))
  let prepared = 0
  for (const doc of pending.slice(0, options.maxItems ?? 128)) {
    const vector = await options.embed(doc.canonicalText)
    if (!options.isCurrent()) throw new Error('Entity publication changed during vector preparation')
    options.index.putBatch([{ memoryId: doc.id, model: options.model, content: doc.canonicalText, vector }])
    prepared++
  }
  return { total: documents.length, prepared, pending: pending.length - prepared }
}
