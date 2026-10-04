import type { CaptureSnapshot, GraphPublicationTask, SemanticWorkItem } from '@continuum-memory/memory'
import type { MemoryActivityReport } from '../shared/memory-activity'

export function buildMemoryActivity(input: {
  enabled: boolean
  capture?: CaptureSnapshot
  publication?: GraphPublicationTask[]
  semantics?: SemanticWorkItem[]
  activeFactIds?: Set<string>
  scope: CaptureSnapshot['sources'][number]['scope']
  awaitingProcessor?: number
  error?: string
}): MemoryActivityReport {
  const sources = (input.capture?.sources ?? []).filter(source => source.status === 'active'
    && source.scope.ownerId === input.scope.ownerId && source.scope.agentId === input.scope.agentId)
  const items = sources.map(source => {
    const ids = new Set([source.id, ...source.messageIds])
    const captures = (input.capture?.tasks ?? []).filter(task => task.sourceId === source.id)
    const semantics = (input.semantics ?? []).filter(item => ids.has(item.run.sourceId))
    const publications = (input.publication ?? []).filter(task => ids.has(task.run.sourceId) && task.state !== 'retired')
    const published = new Set(publications.filter(task => task.state === 'published' && task.factRef
      && (!input.activeFactIds || input.activeFactIds.has(task.factRef.id))).map(task => task.factRef!.id)).size
    return { id: source.id, messageId: source.messageIds[0], text: source.turn?.userMessage.slice(0, 180) ?? '', createdAt: source.createdAt,
      pending: captures.filter(task => task.status === 'pending').length + semantics.filter(item => item.status === 'pending').length
        + publications.filter(task => task.state !== 'published' && !task.lastError).length,
      processing: captures.filter(task => task.status === 'running').length + semantics.filter(item => item.status === 'processing').length,
      clarifying: semantics.filter(item => item.status === 'waiting').reduce((sum, item) => sum + item.decisions.filter(decision => decision.verdict === 'needs-context').length, 0),
      failed: captures.filter(task => task.status === 'failed').length + semantics.filter(item => item.status === 'failed').length
        + publications.filter(task => task.state !== 'published' && task.lastError).length,
      cancelled: captures.filter(task => task.status === 'cancelled').length,
      completed: captures.some(task => task.status === 'succeeded') || semantics.some(item => ['ready','published'].includes(item.status)), published }
  })
  const totals = items.reduce((sum, item) => ({ pending: sum.pending + item.pending, processing: sum.processing + item.processing,
    clarifying: sum.clarifying + item.clarifying, failed: sum.failed + item.failed, published: sum.published + item.published }),
  { pending: 0, processing: 0, clarifying: 0, failed: 0, published: 0 })
  return { enabled: input.enabled, totals, items: items.sort((a,b) => b.createdAt-a.createdAt).slice(0,50), awaitingProcessor: input.awaitingProcessor ?? 0, ...(input.error ? { error: input.error } : {}) }
}
