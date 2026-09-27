import { createLocalHashEmbedding } from './local-embedding'
import type { GraphExtractionRun } from './graph-extraction-result'
import type { GraphEntityRecord } from './graph-identity-normalization'

/** Local similarity hints only. Identity resolution never accepts a vector hit by itself. */
export function graphEntityVectorCandidates(run: GraphExtractionRun, entities: readonly GraphEntityRecord[],
  scope: GraphEntityRecord['scope'], limit = 3): Record<string, Array<{ entityId: string; score: number }>> {
  const catalog = entities.filter(entity => (entity.review === undefined || entity.review.status === 'accepted')
    && entity.scope.ownerId === scope.ownerId && entity.scope.agentId === scope.agentId
    && (entity.scope.sessionId === undefined || entity.scope.sessionId === scope.sessionId))
    .map(entity => ({ entity, vectors: [entity.canonicalName, ...entity.aliases]
      .map(name => createLocalHashEmbedding(name)) }))
  const result: Record<string, Array<{ entityId: string; score: number }>> = {}
  for (const mention of run.entityMentions) {
    const query = createLocalHashEmbedding(mention.text)
    result[mention.id] = catalog.filter(({ entity }) => entity.entityType === mention.type)
      .map(({ entity, vectors }) => ({ entityId: entity.ref.id, score: Math.min(1, Math.max(0,
        ...vectors.map(vector => vector.reduce((sum, value, index) => sum + value * (query[index] ?? 0), 0)))) }))
      .filter(hit => hit.score > 0)
      .sort((a, b) => b.score - a.score || a.entityId.localeCompare(b.entityId))
      .slice(0, limit)
  }
  return result
}
