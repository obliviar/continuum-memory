import { createGraphRecallService } from './graph-recall-service'
import type { GraphRecallPorts } from './graph-recall-service'

export type {
  GraphRecallPorts, GraphTraversalPath, GraphTraversalRecallRequest,
  QueryGraphTraversalRecallRequest, GraphTraversalRecallResult, GraphTraversalRecallData, QueryGraphTraversalRecallResult,
} from './graph-recall-service'

/** Uses the request's maxHops, a root-local BFS and one shared view/budget. */
export function createBoundedGraphRecall(ports: GraphRecallPorts) {
  return createGraphRecallService(ports, 'bounded')
}
