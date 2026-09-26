import type {
  GraphMemoryCapabilities,
  GraphRecallFeedback,
  GraphRecallRequest,
  GraphRecallResult,
  GraphResult,
} from '../types/memory-graph'

/**
 * Explicit opt-in boundary. No adapter may silently translate knownAt into legacy asOf,
 * drop proof requirements, broaden scope, or call an incompatible legacy fallback.
 * Wire values must be validated and authenticated before opening a graph read view.
 */
export interface AgentGraphMemoryPort {
  capabilities: () => GraphMemoryCapabilities
  recall: (request: GraphRecallRequest) => Promise<GraphResult<GraphRecallResult>>
  /** Idempotent by feedbackId; resolve the exact recallId AND manifestId inside scope. */
  reportFeedback: (feedback: GraphRecallFeedback) => Promise<GraphResult<{ readonly recorded: boolean }>>
}
