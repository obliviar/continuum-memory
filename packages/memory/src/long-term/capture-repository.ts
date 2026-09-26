import { createHash, randomUUID } from 'node:crypto'
import type { MemoryCapture, MemoryScope } from '@continuum-memory/contracts'
import type { MemoryPersistence } from './vector-store'

export type CaptureTaskStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'

/** Raw input is evidence, never a reviewed fact or a recall result. */
export interface CaptureSource {
  id: string
  identity: string
  revision: number
  scope: MemoryScope
  /** The original write isolation scope; source identity may additionally include the chat session. */
  writeScope?: MemoryScope
  messageIds: string[]
  contentHash: string
  status: 'active' | 'superseded' | 'deleted'
  createdAt: number
  /** Erased on source deletion, including context and attachment payloads. */
  turn?: MemoryCapture
}

export interface CaptureTask {
  id: string
  sourceId: string
  processorVersion: string
  segmentIndex: number
  segmentCount: number
  /** Half-open offsets into the unmodified source, in JavaScript UTF-16 units. */
  start: number
  end: number
  offsetEncoding: 'utf16'
  preprocessingVersion: 'identity-v1'
  status: CaptureTaskStatus
  attempts: number
  createdAt: number
  updatedAt: number
  candidateCount?: number
  writtenCount?: number
  /** Stable diagnostic code; never stores model output or raw error text. */
  errorCode?: 'interrupted' | 'extraction-or-write-failed'
}

export interface CaptureSnapshot {
  version: 1
  sources: CaptureSource[]
  tasks: CaptureTask[]
}

export interface CaptureStatus {
  activeSources: number
  tasks: Record<CaptureTaskStatus, number>
  retryable: number
  awaitingProcessor: number
}

export interface CaptureRepository {
  snapshot: () => CaptureSnapshot
  status: (processorVersion: string) => CaptureStatus
  register: (turn: MemoryCapture, scope: MemoryScope, processorVersion: string, segmentCharacters?: number) => CaptureTask[]
  pending: (processorVersion: string, retryFailed?: boolean) => CaptureTask[]
  claim: (id: string) => { task: CaptureTask; turn: MemoryCapture; scope: MemoryScope } | undefined
  isCurrent: (id: string) => boolean
  finish: (id: string, result: { candidateCount: number; writtenCount: number } | undefined) => void
  invalidate: (scope: MemoryScope, messageIds?: string[], sourceIds?: string[]) => void
}

const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const within = (value: MemoryScope, scope: MemoryScope): boolean => value.ownerId === scope.ownerId
  && (scope.agentId === undefined || value.agentId === scope.agentId)
  && (scope.sessionId === undefined || value.sessionId === scope.sessionId)

/** Single-process durable inbox. Save succeeds before any in-memory state is published. */
export function createCaptureRepository(options: {
  persistence: Pick<MemoryPersistence, 'load' | 'save' | 'scrubBackups'>
  maximumAttempts?: number
}): CaptureRepository {
  const maximumAttempts = Number.isFinite(options.maximumAttempts)
    ? Math.max(1, Math.floor(options.maximumAttempts!)) : 3
  const payload = options.persistence.load()
  let state: CaptureSnapshot = payload ? JSON.parse(payload) as CaptureSnapshot : { version: 1, sources: [], tasks: [] }
  if (state.version !== 1 || !Array.isArray(state.sources) || !Array.isArray(state.tasks))
    throw new Error('Invalid capture repository snapshot')
  const sourceIds = new Set<string>()
  const taskIds = new Set<string>()
  for (const source of state.sources) {
    if (!source.id || sourceIds.has(source.id) || !source.scope?.ownerId || typeof source.identity !== 'string'
      || !Number.isInteger(source.revision) || source.revision < 1
      || (source.writeScope && (source.writeScope.ownerId !== source.scope.ownerId
        || source.writeScope.agentId !== source.scope.agentId
        || (source.writeScope.sessionId !== undefined && source.writeScope.sessionId !== source.scope.sessionId)))
      || !Array.isArray(source.messageIds) || !['active', 'superseded', 'deleted'].includes(source.status)
      || (source.status === 'active' && typeof source.turn?.userMessage !== 'string'))
      throw new Error('Invalid capture source')
    sourceIds.add(source.id)
  }
  for (const task of state.tasks) {
    const source = state.sources.find(item => item.id === task.sourceId)
    if (!task.id || taskIds.has(task.id) || !source || typeof task.processorVersion !== 'string'
      || !['pending', 'running', 'succeeded', 'failed', 'cancelled'].includes(task.status)
      || !Number.isInteger(task.start) || !Number.isInteger(task.end) || task.start < 0 || task.end < task.start
      || task.offsetEncoding !== 'utf16' || task.preprocessingVersion !== 'identity-v1'
      || !Number.isInteger(task.segmentIndex) || !Number.isInteger(task.segmentCount)
      || task.segmentIndex < 0 || task.segmentIndex >= task.segmentCount
      || !Number.isInteger(task.attempts) || task.attempts < 0
      || (source.status !== 'active' && !['succeeded', 'cancelled'].includes(task.status))
      || (source.turn && task.end > source.turn.userMessage.length))
      throw new Error('Invalid capture task')
    taskIds.add(task.id)
  }
  function commit(next: CaptureSnapshot): void {
    options.persistence.save(JSON.stringify(next))
    state = next
  }
  if (state.tasks.some(task => task.status === 'running')) {
    const recovered = copy(state)
    for (const task of recovered.tasks) {
      if (task.status !== 'running') continue
      task.status = task.attempts >= maximumAttempts ? 'failed' : 'pending'
      task.errorCode = 'interrupted'
      task.updatedAt = Date.now()
    }
    commit(recovered)
  }
  return {
    snapshot: () => copy(state),
    status(processorVersion) {
      const tasks: CaptureStatus['tasks'] = { pending: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 }
      let retryable = 0
      let awaitingProcessor = 0
      for (const task of state.tasks) {
        tasks[task.status] += 1
        if (!['pending', 'failed'].includes(task.status) || task.attempts >= maximumAttempts) continue
        if (task.processorVersion !== processorVersion) awaitingProcessor += 1
        else retryable += 1
      }
      return { activeSources: state.sources.filter(source => source.status === 'active').length, tasks, retryable, awaitingProcessor }
    },
    register(turn, scope, processorVersion, segmentCharacters = 1800) {
      if (!scope.ownerId || !processorVersion) throw new Error('Capture scope and processor version are required')
      if (turn.userMessage.length > 100_000) throw new Error('Capture source exceeds 100000 UTF-16 units')
      // Preserve replay inputs, including local image payloads, under the encrypted persistence boundary.
      const storedTurn = copy({ ...turn, originalUserMessage: undefined })
      if (Buffer.byteLength(JSON.stringify(storedTurn), 'utf8') > 16 * 1024 * 1024)
        throw new Error('Capture input exceeds 16 MiB')
      const messageIds = [...new Set((Array.isArray(turn.metadata?.sourceMessageIds)
        ? turn.metadata.sourceMessageIds : []).filter((id): id is string => typeof id === 'string' && !!id.trim()).map(id => id.trim()))].sort()
      const sourceScope = { ...scope, ...(scope.sessionId ? {} : typeof turn.metadata?.sessionId === 'string' ? { sessionId: turn.metadata.sessionId } : {}) }
      const explicitId = typeof turn.metadata?.memoryCaptureId === 'string' ? turn.metadata.memoryCaptureId : undefined
      const identity = hash(JSON.stringify([sourceScope.ownerId, sourceScope.agentId ?? null, sourceScope.sessionId ?? null,
        messageIds.length ? messageIds : explicitId ?? randomUUID()]))
      const contentHash = hash(JSON.stringify([storedTurn.userMessage, storedTurn.attachments ?? []]))
      const existing = state.sources.find(source => source.identity === identity && source.status === 'active')
      if (existing?.contentHash === contentHash)
        return copy(state.tasks.filter(task => task.sourceId === existing.id))
      const next = copy(state)
      for (const source of next.sources.filter(item => item.identity === identity && item.status === 'active')) {
        source.status = 'superseded'
        for (const task of next.tasks.filter(item => item.sourceId === source.id && item.status !== 'succeeded'))
          task.status = 'cancelled'
      }
      const createdAt = Date.now()
      const source: CaptureSource = {
        id: randomUUID(), identity, revision: 1 + Math.max(0, ...next.sources.filter(item => item.identity === identity).map(item => item.revision)),
        scope: sourceScope, writeScope: copy(scope), messageIds, contentHash, status: 'active', createdAt, turn: storedTurn,
      }
      next.sources.push(source)
      // Anonymous sources also need stable evidence IDs so a merged fact can purge every contributing source.
      if (!source.messageIds.length) {
        source.messageIds = [`capture-source:${source.id}`]
        storedTurn.metadata = { ...storedTurn.metadata, sourceMessageIds: source.messageIds }
      }
      const limit = Number.isFinite(segmentCharacters) ? Math.max(256, Math.min(6000, Math.floor(segmentCharacters))) : 1800
      const ranges: Array<{ start: number; end: number }> = []
      for (let start = 0; start < storedTurn.userMessage.length;) {
        let end = Math.min(start + limit, storedTurn.userMessage.length)
        if (end < storedTurn.userMessage.length) {
          const window = storedTurn.userMessage.slice(start, end)
          const boundary = [...window.matchAll(/[。！？!?；;\n]/gu)].at(-1)
          if (boundary && boundary.index! + 1 >= limit / 2) end = start + boundary.index! + 1
        }
        if (end < storedTurn.userMessage.length && /[\uD800-\uDBFF]/u.test(storedTurn.userMessage[end - 1]!)) end -= 1
        ranges.push({ start, end })
        start = end
      }
      if (!ranges.length) ranges.push({ start: 0, end: 0 })
      const tasks: CaptureTask[] = ranges.map((range, segmentIndex) => ({
        id: randomUUID(), sourceId: source.id, processorVersion, ...range,
        segmentIndex, segmentCount: ranges.length, offsetEncoding: 'utf16', preprocessingVersion: 'identity-v1',
        status: 'pending', attempts: 0, createdAt, updatedAt: createdAt,
      }))
      next.tasks.push(...tasks)
      commit(next)
      return copy(tasks)
    },
    pending: (processorVersion, retryFailed = false) => copy(state.tasks.filter(task => task.processorVersion === processorVersion
      && (task.status === 'pending' || (retryFailed && task.status === 'failed')) && task.attempts < maximumAttempts
      && state.sources.some(source => source.id === task.sourceId && source.status === 'active'))),
    claim(id) {
      const next = copy(state)
      const task = next.tasks.find(item => item.id === id)
      const source = next.sources.find(item => item.id === task?.sourceId)
      if (!task || !source?.turn || source.status !== 'active' || !['pending', 'failed'].includes(task.status) || task.attempts >= maximumAttempts)
        return undefined
      task.status = 'running'
      task.attempts += 1
      task.updatedAt = Date.now()
      delete task.errorCode
      commit(next)
      const turn = copy(source.turn)
      turn.originalUserMessage = turn.userMessage
      turn.userMessage = turn.userMessage.slice(task.start, task.end)
      turn.metadata = { ...turn.metadata, memoryCaptureId: source.id, memoryCaptureTaskId: task.id,
        memorySourceRevision: source.revision, memoryCaptureSegmentIndex: task.segmentIndex,
        memoryCaptureSegmentCount: task.segmentCount, memorySourceStart: task.start, memorySourceEnd: task.end,
        memorySourceOffsetEncoding: task.offsetEncoding, memoryCapturePlannerVersion: task.preprocessingVersion,
        memoryCaptureProcessorVersion: task.processorVersion }
      return { task: copy(task), turn, scope: copy(source.writeScope ?? source.scope) }
    },
    isCurrent: id => state.tasks.some(task => task.id === id && task.status === 'running'
      && state.sources.some(source => source.id === task.sourceId && source.status === 'active')),
    finish(id, result) {
      const next = copy(state)
      const task = next.tasks.find(item => item.id === id)
      if (!task || task.status !== 'running') return
      task.status = result ? 'succeeded' : 'failed'
      task.updatedAt = Date.now()
      if (result) Object.assign(task, result)
      else task.errorCode = 'extraction-or-write-failed'
      commit(next)
    },
    invalidate(scope, messageIds, sourceIds) {
      const next = copy(state)
      for (const source of next.sources) {
        if (!within(source.scope, scope) || (messageIds && !sourceIds?.includes(source.id) && !source.messageIds.some(id => messageIds.includes(id))
          && !source.turn?.context?.recentMessages.some(message => message.id && messageIds.includes(message.id)))) continue
        source.status = 'deleted'
        delete source.turn
        source.contentHash = ''
        for (const task of next.tasks.filter(item => item.sourceId === source.id)) {
          task.status = 'cancelled'
          task.updatedAt = Date.now()
          delete task.errorCode
        }
      }
      commit(next)
      options.persistence.scrubBackups?.()
    },
  }
}
