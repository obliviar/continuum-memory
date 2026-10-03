/** Source quotations and discovery routes, not newly derived personal facts. */
export interface SourceRecallEvidence {
  citation: string
  source: { captureId: string; revision: number; contentHash: string; start: number; end: number }
  content: string
  recordedAt: number
  scope: { ownerId: string; agentId?: string; sessionId?: string }
  path: Array<{ sourceId: string; relation: string; mention: string; uncertainIdentity: boolean }>
}
