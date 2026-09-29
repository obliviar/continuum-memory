import { createHash } from 'node:crypto'
import type { GraphScope } from '@continuum-memory/contracts'
import type { CaptureSnapshot } from '../../long-term/capture-repository'
import { inferMemoryPrivacy } from '../../long-term/memory-extractor'
import type { GraphInformationRecord } from '../domain/types'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')

/** A source-only node is published only while its exact encrypted capture is active. */
export function projectCapturedInformation(snapshot: CaptureSnapshot, scope: GraphScope): GraphInformationRecord[] {
  return snapshot.sources.flatMap(source => {
    const content = source.turn?.userMessage
    if (source.status !== 'active' || !content?.trim() || !source.scope.agentId
      || source.scope.ownerId !== scope.ownerId || source.scope.agentId !== scope.agentId
      || (scope.sessionId !== undefined && source.scope.sessionId !== scope.sessionId)
      || source.contentHash !== hash(JSON.stringify([content, source.turn?.attachments ?? []]))) return []
    return [{ ref: { kind: 'information' as const, id: `information:${source.id}`, version: source.revision },
      scope: { ownerId: source.scope.ownerId, agentId: source.scope.agentId, ...(source.scope.sessionId ? { sessionId: source.scope.sessionId } : {}) },
      source: { captureId: source.id, revision: source.revision, contentHash: source.contentHash },
      content, recordedAt: source.createdAt, status: 'source-only' as const,
      sensitivity: inferMemoryPrivacy(content).sensitivity, sharePolicy: 'local-only' as const }]
  }).sort((a, b) => a.ref.id.localeCompare(b.ref.id))
}
