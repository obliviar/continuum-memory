import type { MemoryV4ReadDecision } from '@continuum-memory/memory'
import { describe, expect, it } from 'vitest'
import {
  MEMORY_V4_RUNTIME_REPORT_VERSION,
  createMemoryV4RuntimeObservability,
} from './memory-v4-runtime-observability'

type AdaptiveMemoryRecallResult = MemoryV4ReadDecision['result']

describe('Memory V4 runtime observability', () => {
  it('persists bounded read-source, fallback, latency, evidence, Worker and scale rollups', () => {
    const persistence = createMemoryPersistence()
    let currentTime = Date.UTC(2026, 7, 29, 8, 0, 0)
    const observability = createMemoryV4RuntimeObservability({
      persistence,
      now: () => currentTime,
      saveDelayMs: 1,
    })

    observability.record(v4Decision(20, 4, 2), {
      workerEpoch: 'launch-1',
      worker: workerSnapshot({ starts: 1, requests: 1, completed: 1, snapshotSyncs: 1 }),
      index: { revision: 7, summaries: 2, facts: 20_000, rebuildCount: 1 },
      memory: { revision: 7, facts: 20_000, factVersions: 20_050, derivedArtifacts: 40 },
    })
    currentTime += 1_000
    observability.record(v3Decision('v4-abstained', 40), {
      workerEpoch: 'launch-1',
      worker: workerSnapshot({ starts: 1, requests: 2, completed: 2, snapshotSyncs: 1 }),
    })
    currentTime += 1_000
    observability.record(v3Decision('v4-not-ready', 100), {
      workerEpoch: 'launch-1',
      worker: workerSnapshot({
        starts: 2,
        restarts: 1,
        requests: 3,
        completed: 2,
        failures: 1,
        snapshotSyncs: 1,
      }),
    })

    const report = observability.status()
    expect(report).toMatchObject({
      version: MEMORY_V4_RUNTIME_REPORT_VERSION,
      launchCount: 1,
      total: {
        reads: 3,
        readSources: { v3: 2, v4: 1 },
        requestedModes: { v3: 0, 'v4-beta': 0, auto: 3 },
        v4ReadRate: 0.33,
        fallbacks: {
          total: 2,
          rate: 0.67,
          reasons: { 'v4-abstained': 1, 'v4-not-ready': 1 },
        },
        recoveries: { total: 0, fromReasons: {} },
        v4Attempts: 2,
        v4EvidenceSufficientRate: 0.5,
        latencyMs: {
          samples: 3,
          average: 53.33,
          p50: 40,
          p95: 100,
          targetP95Ms: 100,
          targetMet: false,
        },
        candidateCount: { average: 2, max: 4 },
        selectedEvidenceCount: { average: 0.67, max: 2 },
      },
      worker: {
        starts: 2,
        restarts: 1,
        requests: 3,
        completed: 2,
        failures: 1,
      },
      index: { revision: 7, facts: 20_000, rebuildCount: 1 },
      memory: { revision: 7, facts: 20_000, factVersions: 20_050 },
      policy: { policyId: 'test-policy', policyVersion: 'test-v1', fingerprint: 'test-fingerprint' },
      last: { authoritativeReadSource: 'v3', fallbackReason: 'v4-not-ready' },
    })
    expect(report.days).toHaveLength(1)
    expect(report.days[0]).toMatchObject({ day: '2026-08-29', reads: 3 })
    expect(persistence.value('memory-v4-runtime-report')).toMatchObject({ total: { reads: 3 } })
    expect(JSON.stringify(report)).not.toContain('我叫什么名字')

    const restarted = createMemoryV4RuntimeObservability({
      persistence,
      now: () => currentTime + 60_000,
      saveDelayMs: 1,
    })
    restarted.record(v4Decision(10, 1, 1), {
      // Even identical counters belong to a new process epoch and must be added.
      workerEpoch: 'launch-2',
      worker: workerSnapshot({
        starts: 2,
        restarts: 1,
        requests: 3,
        completed: 2,
        failures: 1,
        snapshotSyncs: 1,
      }),
    })
    expect(restarted.status()).toMatchObject({
      launchCount: 2,
      total: { reads: 4, readSources: { v3: 2, v4: 2 } },
      worker: { starts: 4, restarts: 2, requests: 6, completed: 4, failures: 2 },
    })
    expect(restarted.status().total.recoveries).toEqual({
      total: 1,
      fromReasons: { 'v4-not-ready': 1 },
    })
  })

  it('fails open when the stored telemetry has an incompatible version', () => {
    const persistence = createMemoryPersistence({
      'memory-v4-runtime-observability': { version: 'future-version', total: { reads: 99 } },
    })
    const observability = createMemoryV4RuntimeObservability({
      persistence,
      now: () => Date.UTC(2026, 7, 29),
    })

    expect(observability.status()).toMatchObject({ launchCount: 1, total: { reads: 0 } })
  })
})

function v4Decision(latencyMs: number, candidateCount: number, selectedEvidenceCount: number): MemoryV4ReadDecision {
  const ids = Array.from({ length: selectedEvidenceCount }, (_, index) => `fact-${index + 1}`)
  return {
    version: 'memory-v4-read-router-v1',
    requestedMode: 'auto',
    authoritativeReadSource: 'v4',
    latencyMs,
    result: recallResult(candidateCount, ids),
    evidenceBundle: {
      version: 'memory-v4-evidence-bundle-v1',
      source: 'v4',
      retrieverVersion: 'memory-v4-shadow-retriever-v2',
      retrievalPolicy: {
        policyId: 'test-policy',
        policyVersion: 'test-v1',
        fingerprint: 'test-fingerprint',
      },
      snapshotRevision: 7,
      queryIntent: 'specific',
      candidateCount,
      retrievalRoutes: ['fact-bm25'],
      summariesUsed: [],
      selectedFactIds: ids,
      selectedMemoryIds: ids,
      entries: ids.map((id, index) => ({
        citation: `M${index + 1}`,
        factId: id,
        memoryId: id,
        content: `fact ${index + 1}`,
        score: 1,
        routes: ['fact-bm25'],
        summaryIds: [],
        status: 'active',
        verificationState: 'verified',
        sharePolicy: 'allow-remote',
        sensitivity: 'normal',
      })),
      latencyMs,
    },
  }
}

function v3Decision(
  fallbackReason: NonNullable<MemoryV4ReadDecision['fallbackReason']>,
  latencyMs: number,
): MemoryV4ReadDecision {
  return {
    version: 'memory-v4-read-router-v1',
    requestedMode: 'auto',
    authoritativeReadSource: 'v3',
    fallbackReason,
    latencyMs,
    result: recallResult(1, ['v3-memory']),
  }
}

function recallResult(candidateCount: number, ids: string[]): AdaptiveMemoryRecallResult {
  return {
    memories: ids.map(id => ({ id, content: 'test', createdAt: 1 })),
    retrievedMemoryIds: [...ids],
    injectedMemoryIds: [...ids],
    candidateCount,
    evaluatedCount: candidateCount,
    batchesEvaluated: candidateCount > 0 ? 1 : 0,
    stopReason: candidateCount > 0 ? 'candidates-exhausted' : 'no-candidates',
  }
}

function workerSnapshot(
  patch: Partial<ReturnType<typeof emptyWorkerSnapshot>>,
): ReturnType<typeof emptyWorkerSnapshot> {
  return { ...emptyWorkerSnapshot(), ...patch }
}

function emptyWorkerSnapshot() {
  return {
    starts: 0,
    restarts: 0,
    requests: 0,
    completed: 0,
    failures: 0,
    timeouts: 0,
    cancellations: 0,
    snapshotSyncs: 0,
    semanticSyncs: 0,
  }
}

function createMemoryPersistence(initial: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(initial))
  return {
    loadJson<T>(slot: string, fallback: T): T {
      return structuredClone((values.get(slot) ?? fallback) as T)
    },
    saveJsonDebounced(slot: string, data: unknown): void {
      values.set(slot, structuredClone(data))
    },
    value(slot: string): any {
      return values.get(slot)
    },
  }
}
