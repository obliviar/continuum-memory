import type {
  AgentMemoryPort,
  MemoryCapture,
  MemoryRecallFeedbackReport,
  MemoryScope,
  MemorySourceSyncResult,
} from '@continuum-memory/contracts'
import type { V3MemoryRecord, VectorStore } from './vector-store'
import { extractMemoryCandidates, isSafeMemoryContent } from './memory-extractor'
import type { MemoryCandidate, MemoryExtractor } from './memory-extractor'
import { normalizeMemoryCandidate } from './memory-normalizer'
import { planMemoryCapture } from './memory-capture-planner'
import type { CaptureRepository, CaptureSnapshot, CaptureStatus } from './capture-repository'
import {
  createLocalMemoryCandidateVerifier,
  quarantinedVerifierFailure,
} from './memory-write-policy'
import type {
  MemoryCandidateEvaluation,
  MemoryCandidateVerifier,
} from './memory-write-policy'

export interface MemoryCaptureCommit {
  turn: MemoryCapture
  scope: MemoryScope
  memories: Array<{ candidate: MemoryCandidate; record: V3MemoryRecord }>
  evaluations: MemoryCandidateEvaluation[]
  capturedAt: number
}

export interface MemorySourceUnlinkCommit {
  messageIds: string[]
  scope: MemoryScope
  result: MemorySourceSyncResult
  unlinkedAt: number
}

export interface MemoryWriterOptions {
  store: VectorStore
  extractor?: MemoryExtractor
  verifier?: MemoryCandidateVerifier
  /** Post-V3 capture observer used by the additive V4 evidence shadow. */
  onCaptured?: (commit: MemoryCaptureCommit) => void
  onCaptureObserverError?: (error: unknown, commit: MemoryCaptureCommit) => void
  onSourcesUnlinked?: (commit: MemorySourceUnlinkCommit) => void
  onSourceUnlinkObserverError?: (error: unknown, commit: MemorySourceUnlinkCommit) => void
  /** Post-answer observer used by the V4 shadow to close the adopted/corrected/denied loop. */
  onRecallFeedback?: (report: MemoryRecallFeedbackReport) => void
  onRecallFeedbackObserverError?: (error: unknown, report: MemoryRecallFeedbackReport) => void
  /** Maximum characters extracted synchronously per segment. */
  maximumSegmentCharacters?: number
  /** Queue backpressure threshold. Overflow waits for the current queue instead of being dropped. */
  maximumQueuedSegments?: number
  /** Independent source inbox. Production callers must provide encrypted persistence. */
  captureRepository?: CaptureRepository
  /** Pins recovery to the configured extraction pipeline; changing it never silently replays old work. */
  captureProcessorVersion?: string
  onBackgroundCaptureError?: (error: unknown, turn: MemoryCapture, scope: MemoryScope) => void
}

export interface MemoryWriter extends AgentMemoryPort {
  pendingCaptureCount: () => number
  flushPendingCaptures: () => Promise<void>
  captureSnapshot: () => CaptureSnapshot | undefined
  captureStatus: () => CaptureStatus | undefined
  resumePendingCaptures: (retryFailed?: boolean) => Promise<void>
}

export function createMemoryWriter(options: MemoryWriterOptions): MemoryWriter {
  const {
    store,
    extractor = extractMemoryCandidates,
    verifier = createLocalMemoryCandidateVerifier(),
    onCaptured,
    onCaptureObserverError,
    onSourcesUnlinked,
    onSourceUnlinkObserverError,
    onRecallFeedback,
    onRecallFeedbackObserverError,
  } = options
  const maximumQueuedSegments = Math.max(1, Math.floor(options.maximumQueuedSegments ?? 64))
  let pendingCaptureSegments = 0
  let backgroundCaptures: Promise<void> = Promise.resolve()
  const captureRepository = options.captureRepository
  const processorVersion = options.captureProcessorVersion ?? 'capture-default-v1'
  const scheduled = new Set<string>()

  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    pendingCaptureSegments += 1
    const result = backgroundCaptures.then(operation)
    backgroundCaptures = result.then(() => {}, () => {}).finally(() => { pendingCaptureSegments -= 1 })
    return result
  }

  const remember: AgentMemoryPort['remember'] = async (content, scope, metadata) => {
    if (!isSafeMemoryContent(content))
      throw new Error('Memory content is empty or contains unsafe instructions or sensitive data')
    await store.remember(content, scope, metadata)
  }

  async function processCapture(turn: MemoryCapture, scope: MemoryScope, current = () => true, onExtracted?: (count: number) => void): Promise<number> {
    const extracted = await extractor(turn)
    onExtracted?.(extracted.length)
    if (!current()) return 0
    const candidates = extracted.map(candidate => normalizeMemoryCandidate(candidate, turn))
    const memories: MemoryCaptureCommit['memories'] = []
    const evaluations: MemoryCandidateEvaluation[] = []
    for (const candidate of candidates) {
      let evaluation: MemoryCandidateEvaluation
      try {
        const memoryKey = typeof candidate.metadata.memoryKey === 'string'
          ? candidate.metadata.memoryKey.trim()
          : typeof candidate.metadata.predicate === 'string' ? candidate.metadata.predicate.trim() : undefined
        const matches = await store.inspectWriteMatches(candidate.content, scope, memoryKey)
        evaluation = await verifier(candidate, { turn, scope, matches })
      }
      catch {
        evaluation = quarantinedVerifierFailure(candidate)
      }
      evaluations.push(evaluation)
      if (!current()) return memories.length
      if (evaluation.status !== 'accepted' || evaluation.action === 'NOOP')
        continue
      const record = await store.remember(candidate.content, scope, {
        ...turn.metadata,
        ...candidate.metadata,
        memoryWriteAction: evaluation.action,
        memoryVerificationScore: evaluation.verificationScore,
        memoryEvidenceScore: evaluation.evidenceScore,
        memoryDurabilityScore: evaluation.durabilityScore,
        memoryAmbiguityFlags: evaluation.ambiguityFlags,
        memoryVerifierVersion: evaluation.verifierVersion,
        memoryPolicyVersion: evaluation.policyVersion,
        ...(evaluation.matchedMemoryId ? { memoryMatchedId: evaluation.matchedMemoryId } : {}),
        origin: candidate.metadata.origin ?? (turn.attachments?.length ? 'image' : 'automatic'),
      })
      if (record)
        memories.push({ candidate, record })
    }
    if (onCaptured && evaluations.length > 0 && current()) {
      const commit: MemoryCaptureCommit = {
        turn,
        scope,
        memories,
        evaluations,
        capturedAt: Date.now(),
      }
      try {
        onCaptured(commit)
      }
      catch (error) {
        try {
          onCaptureObserverError?.(error, commit)
        }
        catch {
          // Shadow diagnostics must never make the working V3 capture fail.
        }
      }
    }
    return memories.length
  }

  function scheduleTask(id: string): Promise<number> {
    if (scheduled.has(id)) return Promise.resolve(0)
    scheduled.add(id)
    return serialize(async () => {
      const input = captureRepository!.claim(id)
      if (!input) return 0
      let candidateCount = 0
      try {
        const writtenCount = await processCapture(input.turn, input.scope,
          () => captureRepository!.isCurrent(id), count => { candidateCount = count })
        captureRepository!.finish(id, { candidateCount, writtenCount })
        return writtenCount
      }
      catch (error) {
        captureRepository!.finish(id, undefined)
        try { options.onBackgroundCaptureError?.(error, input.turn, input.scope) }
        catch { /* diagnostics cannot prevent queue progress */ }
        return 0
      }
    }).finally(() => { scheduled.delete(id) })
  }

  async function resumePendingCaptures(retryFailed = false): Promise<void> {
    // Enqueue the complete recovery batch synchronously so flush includes all recovered tasks.
    await Promise.all((captureRepository?.pending(processorVersion, retryFailed) ?? []).map(task => scheduleTask(task.id)))
  }

  async function processCaptureSafely(turn: MemoryCapture, scope: MemoryScope): Promise<number> {
    try {
      return await processCapture(turn, scope)
    }
    catch (error) {
      try { options.onBackgroundCaptureError?.(error, turn, scope) }
      catch { /* diagnostics must not stop later capture segments */ }
      return 0
    }
  }

  function enqueueBackground(turn: MemoryCapture, scope: MemoryScope): void {
    pendingCaptureSegments += 1
    backgroundCaptures = backgroundCaptures
      .then(async () => { await processCaptureSafely(turn, scope) })
      .finally(() => { pendingCaptureSegments -= 1 })
  }

  async function flushPendingCaptures(): Promise<void> {
    while (pendingCaptureSegments > 0) {
      const pending = backgroundCaptures
      await pending
      if (pending === backgroundCaptures)
        break
    }
  }

  const writer: MemoryWriter = {
    list: store.list,
    recall: store.recall,
    recallAdaptive: store.recallAdaptive,
    remember,
    forget: store.forget,
    async purge(id, scope) {
      if (!captureRepository) return store.purge(id, scope)
      return serialize(async () => {
        const record = store.get(id, scope)
        if (record) {
          captureRepository.invalidate(scope, record.sourceMessageIds ?? [],
            typeof record.metadata?.memoryCaptureId === 'string' ? [record.metadata.memoryCaptureId] : [])
        }
        return store.purge(id, scope)
      })
    },
    update: store.update,
    restore: store.restore,
    async unlinkSources(messageIds, scope) {
      const normalizedMessageIds = [...new Set(messageIds
        .filter(id => typeof id === 'string' && id.trim())
        .map(id => id.trim()))]
      captureRepository?.invalidate(scope, normalizedMessageIds)
      const result = captureRepository
        ? await serialize(() => store.unlinkSources(normalizedMessageIds, scope))
        : await store.unlinkSources(normalizedMessageIds, scope)
      if (onSourcesUnlinked && normalizedMessageIds.length > 0) {
        const commit: MemorySourceUnlinkCommit = {
          messageIds: normalizedMessageIds,
          scope,
          result,
          unlinkedAt: Date.now(),
        }
        try {
          onSourcesUnlinked(commit)
        }
        catch (error) {
          try {
            onSourceUnlinkObserverError?.(error, commit)
          }
          catch {
            // V4 cleanup diagnostics must never make the authoritative V3 unlink fail.
          }
        }
      }
      return result
    },
    async clear(scope) {
      captureRepository?.invalidate(scope)
      if (captureRepository) await serialize(() => store.clear(scope))
      else await store.clear(scope)
    },
    count: store.count,
    async reportRecallFeedback(report: MemoryRecallFeedbackReport): Promise<void> {
      const outcomes = report.outcomes
        .filter(entry => !!entry && typeof entry.memoryId === 'string' && entry.memoryId.trim())
      if (!onRecallFeedback || outcomes.length === 0)
        return
      const normalized: MemoryRecallFeedbackReport = {
        query: report.query,
        scope: report.scope,
        outcomes: outcomes.map(entry => ({
          memoryId: entry.memoryId.trim(),
          outcome: entry.outcome,
        })),
        ...(report.answerModel ? { answerModel: report.answerModel } : {}),
      }
      try {
        onRecallFeedback(normalized)
      }
      catch (error) {
        try {
          onRecallFeedbackObserverError?.(error, normalized)
        }
        catch {
          // Feedback diagnostics must never fail the finished answer turn.
        }
      }
    },
    async capture(turn, scope): Promise<number> {
      if (captureRepository) {
        const tasks = captureRepository.register(turn, scope, processorVersion, options.maximumSegmentCharacters)
          .filter(task => task.status === 'pending' && task.processorVersion === processorVersion)
        if (!tasks.length) return 0
        // The entire source and all segments are durable before the first extractor call.
        const first = scheduleTask(tasks[0]!.id)
        for (const task of tasks.slice(1)) {
          void scheduleTask(task.id).catch(error => {
            try { options.onBackgroundCaptureError?.(error, turn, scope) }
            catch { /* best-effort diagnostic */ }
          })
        }
        return first
      }
      const plan = planMemoryCapture(turn, options.maximumSegmentCharacters)
      if (plan.length === 0)
        return 0
      const written = await processCaptureSafely(plan[0]!.turn, scope)
      const continuation = plan.slice(1)
      for (const segment of continuation) {
        if (pendingCaptureSegments >= maximumQueuedSegments)
          await flushPendingCaptures()
        enqueueBackground(segment.turn, scope)
      }
      return written
    },
    pendingCaptureCount: () => pendingCaptureSegments,
    flushPendingCaptures,
    captureSnapshot: () => captureRepository?.snapshot(),
    captureStatus: () => captureRepository?.status(processorVersion),
    resumePendingCaptures,
  }
  return writer
}

export type { MemoryExtractor } from './memory-extractor'
export type { MemoryCandidateEvaluation, MemoryCandidateVerifier } from './memory-write-policy'
export { extractMemoryCandidates, inferMemoryPrivacy, isSafeMemoryContent } from './memory-extractor'
