import type {
  GraphProtocolError,
  GraphProtocolVersion,
  GraphRecallRequest,
  GraphRecallResult,
} from '@continuum-memory/contracts'
import type { GraphProjectionSnapshot } from '../domain/types'
import type { GraphHierarchySnapshot } from '../domain/hierarchy-types'
import type { GraphOpenViewRequest } from './graph-ports'

/** Future graph Worker only; NOT accepted by the existing V4 shadow Worker handler. */
export type GraphWorkerRequest = {
  readonly protocolVersion: GraphProtocolVersion
  readonly requestId: string
} & (
  | { readonly type: 'graph/sync'; readonly snapshot: GraphProjectionSnapshot }
  | { readonly type: 'graph/hierarchy-sync'; readonly snapshot: GraphHierarchySnapshot }
  | { readonly type: 'graph/open'; readonly context: GraphOpenViewRequest }
  | { readonly type: 'graph/recall'; readonly viewId: string; readonly manifestId: string; readonly request: GraphRecallRequest }
  | { readonly type: 'graph/drop'; readonly viewId: string; readonly manifestId: string }
)

export type GraphWorkerResponse = {
  readonly protocolVersion: GraphProtocolVersion
  readonly requestId: string
} & (
  | { readonly type: 'graph/synced'; readonly manifestId: string }
  | { readonly type: 'graph/hierarchy-synced'; readonly manifestId: string; readonly coreManifestId: string }
  | { readonly type: 'graph/ready'; readonly viewId: string; readonly manifestId: string; readonly hierarchyManifestId?: string; readonly authorizationVersion: string }
  | { readonly type: 'graph/result'; readonly viewId: string; readonly manifestId: string; readonly result: GraphRecallResult }
  | { readonly type: 'graph/dropped'; readonly viewId: string; readonly manifestId: string }
  | { readonly type: 'graph/error'; readonly error: GraphProtocolError }
)
