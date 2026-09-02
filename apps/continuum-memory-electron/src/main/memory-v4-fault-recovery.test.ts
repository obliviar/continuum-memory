import {
  createMemoryV4Repository,
  createMemoryV4ShadowRetriever,
  createV4ShadowWriter,
} from '@continuum-memory/memory'
import type {
  MemoryV4ReadDecision,
  MemoryV4ShadowRecallOptions,
  MemoryV4ShadowRecallResult,
  MemoryV4Snapshot,
} from '@continuum-memory/memory'
import { describe, expect, it } from 'vitest'
import { createMemoryV4ReadController } from './memory-v4-read-controller'
import { createMemoryV4RuntimeObservability } from './memory-v4-runtime-observability'
import { createMemoryV4ShadowWorkerClient } from './memory-v4-shadow-worker-client'
import type {
  MemoryV4ShadowWorkerRequest,
  MemoryV4ShadowWorkerResponse,
} from './memory-v4-shadow-worker-protocol'

const START = Date.UTC(2026, 7, 29, 12)
const ITERATIONS = 200
const FAILURE_INTERVAL = 31
const WRITE_INTERVAL = 5
const scope = { ownerId: 'fault-lab-user', agentId: 'deskpet' }

type AdaptiveMemoryRecallResult = MemoryV4ReadDecision['result']
type HandlerMap = {
  message: Array<(message: MemoryV4ShadowWorkerResponse) => void>
  error: Array<(error: Error) => void>
  exit: Array<(exitCode: number) => void>
}

class FaultLabWorker {
  readonly messages: MemoryV4ShadowWorkerRequest[] = []
  terminated = false
  private readonly handlers: HandlerMap = { message: [], error: [], exit: [] }

  constructor(private readonly respond: (request: MemoryV4ShadowWorkerRequest, worker: FaultLabWorker) => void) {}

  on(event: 'message', listener: (message: MemoryV4ShadowWorkerResponse) => void): FaultLabWorker
  on(event: 'error', listener: (error: Error) => void): FaultLabWorker
  on(event: 'exit', listener: (exitCode: number) => void): FaultLabWorker
  on(event: keyof HandlerMap, listener: HandlerMap[keyof HandlerMap][number]): FaultLabWorker {
    if (event === 'message')
      this.handlers.message.push(listener as (message: MemoryV4ShadowWorkerResponse) => void)
    else if (event === 'error')
      this.handlers.error.push(listener as (error: Error) => void)
    else
      this.handlers.exit.push(listener as (exitCode: number) => void)
    return this
  }

  postMessage(request: MemoryV4ShadowWorkerRequest): void {
    this.messages.push(request)
    this.respond(request, this)
  }

  reply(response: MemoryV4ShadowWorkerResponse): void {
    for (const listener of this.handlers.message)
      listener(response)
  }

  exit(exitCode: number): void {
    for (const listener of this.handlers.exit)
      listener(exitCode)
  }

  terminate(): Promise<number> {
    this.terminated = true
    return Promise.resolve(0)
  }
}

describe('Memory V4 continuous fault and recovery lab', () => {
  it('keeps writes visible, falls back on Worker exits, and automatically returns to V4', async () => {
    let clock = START
    const now = () => ++clock
    const repository = createMemoryV4Repository({ now })
    const writer = createV4ShadowWriter({ repository, now, flushDelayMs: 60_000 })
    const sourceItems = [v3Item('name', '用户姓名：小秦', 'profile.name')]
    writer.reconcileV3Payload(v3Payload(sourceItems))

    let requestCount = 0
    const workers: FaultLabWorker[] = []
    const workerClient = createMemoryV4ShadowWorkerClient({
      workerPath: 'memory-v4-shadow-worker.js',
      getSnapshot: repository.snapshot,
      timeoutMs: 1_000,
      workerFactory: () => {
        let workerSnapshot: MemoryV4Snapshot | undefined
        const worker = new FaultLabWorker((request, current) => {
          requestCount += 1
          if (requestCount % FAILURE_INTERVAL === 0) {
            current.exit(73)
            return
          }
          if (request.snapshot)
            workerSnapshot = structuredClone(request.snapshot)
          if (!workerSnapshot) {
            current.reply({
              type: 'error',
              requestId: request.requestId,
              errorName: 'MissingSnapshot',
              errorFingerprint: 'fault-lab-missing-snapshot',
            })
            return
          }
          current.reply({
            type: 'result',
            requestId: request.requestId,
            result: recallFromWorkerSnapshot(workerSnapshot, request.options),
          })
        })
        workers.push(worker)
        return worker
      },
    })
    const persistence = inMemoryPersistence()
    const observability = createMemoryV4RuntimeObservability({
      persistence,
      now,
      saveDelayMs: 1,
    })
    const decisions: Array<Pick<MemoryV4ReadDecision, 'authoritativeReadSource' | 'fallbackReason'>> = []
    const controller = createMemoryV4ReadController({
      mode: 'auto',
      recallV3: async () => v3Result(),
      recallV4: (query, options) => workerClient.recall(query, options),
      isV4Ready: () => !workerClient.status().active,
      onDecision: (decision) => {
        decisions.push({
          authoritativeReadSource: decision.authoritativeReadSource,
          ...(decision.fallbackReason ? { fallbackReason: decision.fallbackReason } : {}),
        })
        const workerStatus = workerClient.status()
        const snapshot = repository.snapshot()
        observability.record(decision, {
          workerEpoch: 'fault-lab-process',
          workerAvailable: true,
          memoryAvailable: true,
          worker: workerStatus,
          ...(workerStatus.lastIndex ? { index: workerStatus.lastIndex } : {}),
          memory: {
            revision: snapshot.revision,
            facts: snapshot.facts.length,
            factVersions: snapshot.factVersions.length,
            derivedArtifacts: snapshot.derivedArtifacts.length,
          },
        })
      },
    })

    for (let index = 0; index < ITERATIONS; index += 1) {
      if (index > 0 && index % WRITE_INTERVAL === 0) {
        sourceItems.push(v3Item(
          `project-${index}`,
          `用户长期项目记录 ${index}`,
          `project.note.${index}`,
        ))
        expect(writer.reconcileV3Payload(v3Payload(sourceItems)).changed).toBe(true)
      }
      const recalled = await controller.recallAdaptive('我的姓名是什么？', scope, { maxInjected: 3 })
      expect(recalled.injectedMemoryIds.length).toBeGreaterThan(0)
    }

    const expectedFailures = Math.floor(ITERATIONS / FAILURE_INTERVAL)
    const expectedFacts = 1 + Math.floor((ITERATIONS - 1) / WRITE_INTERVAL)
    const v3Decisions = decisions.filter(item => item.authoritativeReadSource === 'v3')
    const recoveryTransitions = decisions.filter((item, index) =>
      item.authoritativeReadSource === 'v4'
      && decisions[index - 1]?.authoritativeReadSource === 'v3').length
    const controllerStatus = controller.status()
    const workerStatus = workerClient.status()
    const report = observability.status()
    const snapshot = repository.snapshot()

    expect(v3Decisions).toHaveLength(expectedFailures)
    expect(v3Decisions.every(item => item.fallbackReason === 'v4-error')).toBe(true)
    expect(recoveryTransitions).toBe(expectedFailures)
    expect(controllerStatus).toMatchObject({
      reads: ITERATIONS,
      v3Reads: expectedFailures,
      v4Reads: ITERATIONS - expectedFailures,
      fallbacks: expectedFailures,
      fallbackReasons: { 'v4-error': expectedFailures },
      last: { authoritativeReadSource: 'v4' },
    })
    expect(workerStatus).toMatchObject({
      starts: expectedFailures + 1,
      restarts: expectedFailures,
      requests: ITERATIONS,
      completed: ITERATIONS - expectedFailures,
      failures: expectedFailures,
      timeouts: 0,
    })
    expect(workerStatus.snapshotSyncs).toBeGreaterThanOrEqual(expectedFacts)
    expect(workers).toHaveLength(expectedFailures + 1)
    expect(workers.slice(0, -1).every(worker => worker.terminated)).toBe(true)
    expect(snapshot.facts).toHaveLength(expectedFacts)
    expect(report).toMatchObject({
      total: {
        reads: ITERATIONS,
        readSources: { v3: expectedFailures, v4: ITERATIONS - expectedFailures },
        fallbacks: { reasons: { 'v4-error': expectedFailures } },
        recoveries: { total: expectedFailures, fromReasons: { 'v4-error': expectedFailures } },
        latencyMs: { targetMet: true },
      },
      worker: {
        starts: expectedFailures + 1,
        restarts: expectedFailures,
        failures: expectedFailures,
      },
      memory: { revision: snapshot.revision, facts: expectedFacts },
      last: { authoritativeReadSource: 'v4' },
    })

    console.info(JSON.stringify({
      stage: 'memory-v4-continuous-fault-recovery',
      iterations: ITERATIONS,
      writes: expectedFacts,
      workerFailures: expectedFailures,
      v3Fallbacks: v3Decisions.length,
      v4Recoveries: report.total.recoveries.total,
      snapshotSyncs: workerStatus.snapshotSyncs,
      latencyP95Ms: report.total.latencyMs.p95,
      passed: true,
    }))
  }, 20_000)
})

function recallFromWorkerSnapshot(
  snapshot: MemoryV4Snapshot,
  options: MemoryV4ShadowRecallOptions,
): MemoryV4ShadowRecallResult {
  const repository = createMemoryV4Repository({
    persistence: { load: () => JSON.stringify(snapshot), save: () => undefined },
    readOnly: true,
  })
  return createMemoryV4ShadowRetriever(repository).recall('我的姓名是什么？', options)
}

function v3Result(): AdaptiveMemoryRecallResult {
  return {
    memories: [{ id: 'v3-name', content: '用户姓名：小秦', createdAt: START }],
    retrievedMemoryIds: ['v3-name'],
    injectedMemoryIds: ['v3-name'],
    candidateCount: 1,
    evaluatedCount: 1,
    batchesEvaluated: 1,
    stopReason: 'candidates-exhausted',
  }
}

function v3Payload(items: unknown[]): string {
  return JSON.stringify({ version: 3, items })
}

function v3Item(id: string, content: string, memoryKey: string) {
  return {
    id,
    content,
    metadata: { kind: memoryKey.split('.')[0], cardinality: 'single' },
    status: 'active',
    origin: 'manual',
    importance: 0.8,
    confidence: 1,
    accessCount: 0,
    memoryKey,
    sourceMessageIds: [`source-${id}`],
    sourceAttachmentIds: [],
    sharePolicy: 'allow-remote',
    sensitivity: 'normal',
    scope,
    embedding: [],
    embeddingModel: 'local-hash-v3',
    createdAt: START,
    updatedAt: START,
  }
}

function inMemoryPersistence() {
  const values = new Map<string, unknown>()
  return {
    loadJson<T>(slot: string, fallback: T): T {
      return structuredClone((values.get(slot) ?? fallback) as T)
    },
    saveJsonDebounced(slot: string, data: unknown): void {
      values.set(slot, structuredClone(data))
    },
  }
}
