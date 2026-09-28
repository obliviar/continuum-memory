import type { MemoryExtractor } from '@continuum-memory/memory'

/** Graph capture is a side effect; it must not replace or suppress rules candidates. */
export function createRulesWithGraphExtractor(options: {
  readonly rules: MemoryExtractor
  readonly captureGraph: (turn: Parameters<MemoryExtractor>[0]) => Promise<void>
  readonly onGraphError: (error: unknown) => void
}): MemoryExtractor {
  return async turn => {
    const candidates = await options.rules(turn)
    try { await options.captureGraph(turn) }
    catch (error) { options.onGraphError(error) }
    return candidates
  }
}
