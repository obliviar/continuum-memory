import { createGraphRecallService } from './graph-recall-service'
import type {
  GraphRecallPorts, GraphTraversalRecallRequest, QueryGraphTraversalRecallRequest,
  GraphTraversalRecallResult, QueryGraphTraversalRecallResult,
} from './graph-recall-service'

export type OneHopGraphRecallRequest = GraphTraversalRecallRequest
export type QueryOneHopGraphRecallRequest = QueryGraphTraversalRecallRequest
export type OneHopGraphRecallResult = GraphTraversalRecallResult<1>
export type QueryOneHopGraphRecallResult = QueryGraphTraversalRecallResult<1>

/** Compatibility entry point: each root is expanded exactly one hop at most. */
export function createOneHopGraphRecall(ports: GraphRecallPorts) {
  return createGraphRecallService(ports, 'one-hop')
}
