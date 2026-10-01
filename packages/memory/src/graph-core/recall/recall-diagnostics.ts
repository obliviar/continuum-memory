/** Local trusted-host diagnostics only; never appended to the model's evidence prompt. */
export interface RecallStageDiagnostic {
  recallId: string
  route: 'L1' | 'L2'
  stage: 'eligibility' | 'entity-entry' | 'retrieval' | 'candidate-pool' | 'selection' | 'delivery'
  elapsedMs: number
  /** Authorized fact IDs, never source text or IDs of denied records. */
  factIds: readonly string[]
  counts?: Readonly<Record<string, number>>
  details?: readonly string[]
}
export type RecallDiagnostics = (event: RecallStageDiagnostic) => void
export function emitRecallDiagnostic(sink: RecallDiagnostics | undefined, event: RecallStageDiagnostic) {
  try { sink?.(structuredClone(event)) } catch { /* An optional observer cannot change retrieval. */ }
}
