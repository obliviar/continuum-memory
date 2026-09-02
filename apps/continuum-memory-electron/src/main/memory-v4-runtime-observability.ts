import type {
  MemoryV4ReadDecision,
  MemoryV4ReadFallbackReason,
  MemoryV4ReadMode,
} from '@continuum-memory/memory'

export const MEMORY_V4_RUNTIME_OBSERVABILITY_VERSION = 'memory-v4-runtime-observability-v1'
export const MEMORY_V4_RUNTIME_REPORT_VERSION = 'memory-v4-runtime-report-v1'
export const MEMORY_V4_RUNTIME_LATENCY_TARGET_MS = 100

const DEFAULT_STATE_SLOT = 'memory-v4-runtime-observability'
const DEFAULT_REPORT_SLOT = 'memory-v4-runtime-report'
const MAX_LATENCY_SAMPLES = 512
const MAX_DAILY_REPORTS = 31

type ReadSource = MemoryV4ReadDecision['authoritativeReadSource']

interface JsonPersistence {
  loadJson: <T>(slot: string, fallback: T) => T
  saveJsonDebounced: (slot: string, data: unknown, delayMs?: number) => void
}

export interface MemoryV4RuntimeWorkerSnapshot {
  starts: number
  restarts: number
  requests: number
  completed: number
  failures: number
  timeouts: number
  cancellations: number
  snapshotSyncs: number
  semanticSyncs: number
}

export interface MemoryV4RuntimeIndexSnapshot {
  revision: number
  summaries: number
  facts: number
  rebuildCount: number
  semanticFacts?: number
  semanticSummaries?: number
}

export interface MemoryV4RuntimeMemorySnapshot {
  revision: number
  facts: number
  factVersions: number
  derivedArtifacts: number
}

export interface MemoryV4RuntimeObservationContext {
  workerEpoch?: string | number
  workerAvailable?: boolean
  memoryAvailable?: boolean
  worker?: MemoryV4RuntimeWorkerSnapshot
  index?: MemoryV4RuntimeIndexSnapshot
  memory?: MemoryV4RuntimeMemorySnapshot
}

interface CounterRollupState {
  reads: number
  v3Reads: number
  v4Reads: number
  fallbacks: number
  fallbackReasons: Partial<Record<MemoryV4ReadFallbackReason, number>>
  recoveries: number
  recoveryReasons: Partial<Record<MemoryV4ReadFallbackReason, number>>
  requestedModes: Record<MemoryV4ReadMode, number>
  latencyTotalMs: number
  latencySamples: number[]
  candidateTotal: number
  candidateMax: number
  selectedEvidenceTotal: number
  selectedEvidenceMax: number
}

interface MemoryV4RuntimeStoredState {
  version: typeof MEMORY_V4_RUNTIME_OBSERVABILITY_VERSION
  launchCount: number
  lastStartedAt: string
  firstObservedAt?: string
  lastObservedAt?: string
  total: CounterRollupState
  days: Record<string, CounterRollupState>
  workerTotals: MemoryV4RuntimeWorkerSnapshot
  lastIndex?: MemoryV4RuntimeIndexSnapshot
  lastMemory?: MemoryV4RuntimeMemorySnapshot
  lastPolicy?: { policyId: string; policyVersion: string; fingerprint: string }
  last?: MemoryV4RuntimeLastRead
}

export interface MemoryV4RuntimeLastRead {
  observedAt: string
  requestedMode: MemoryV4ReadMode
  authoritativeReadSource: ReadSource
  fallbackReason?: MemoryV4ReadFallbackReason
  latencyMs: number
  candidateCount: number
  selectedEvidenceCount: number
  snapshotRevision?: number
}

export interface MemoryV4RuntimeLatencyReport {
  samples: number
  average: number
  p50: number
  p95: number
  p99: number
  max: number
  targetP95Ms: typeof MEMORY_V4_RUNTIME_LATENCY_TARGET_MS
  targetMet: boolean
}

export interface MemoryV4RuntimeCounterReport {
  reads: number
  readSources: Record<ReadSource, number>
  requestedModes: Record<MemoryV4ReadMode, number>
  v4ReadRate: number
  fallbacks: {
    total: number
    rate: number
    reasons: Partial<Record<MemoryV4ReadFallbackReason, number>>
  }
  recoveries: {
    total: number
    fromReasons: Partial<Record<MemoryV4ReadFallbackReason, number>>
  }
  v4Attempts: number
  v4EvidenceSufficientRate: number
  latencyMs: MemoryV4RuntimeLatencyReport
  candidateCount: { average: number; max: number }
  selectedEvidenceCount: { average: number; max: number }
}

export interface MemoryV4RuntimeDailyReport extends MemoryV4RuntimeCounterReport {
  day: string
}

export interface MemoryV4RuntimeReport {
  version: typeof MEMORY_V4_RUNTIME_REPORT_VERSION
  observabilityVersion: typeof MEMORY_V4_RUNTIME_OBSERVABILITY_VERSION
  generatedAt: string
  launchCount: number
  lastStartedAt: string
  firstObservedAt?: string
  lastObservedAt?: string
  total: MemoryV4RuntimeCounterReport
  days: MemoryV4RuntimeDailyReport[]
  worker: MemoryV4RuntimeWorkerSnapshot
  index?: MemoryV4RuntimeIndexSnapshot
  memory?: MemoryV4RuntimeMemorySnapshot
  policy?: { policyId: string; policyVersion: string; fingerprint: string }
  last?: MemoryV4RuntimeLastRead
}

export interface MemoryV4RuntimeObservability {
  record: (decision: MemoryV4ReadDecision, context?: MemoryV4RuntimeObservationContext) => void
  status: () => MemoryV4RuntimeReport
}

export interface MemoryV4RuntimeObservabilityOptions {
  persistence: JsonPersistence
  stateSlot?: string
  reportSlot?: string
  saveDelayMs?: number
  now?: () => number
}

/**
 * Persistent, bounded operational telemetry for the official V4 read path.
 * It is deliberately downstream of a completed read decision: diagnostics can
 * never select evidence, change routing, or block the answer path.
 */
export function createMemoryV4RuntimeObservability(
  options: MemoryV4RuntimeObservabilityOptions,
): MemoryV4RuntimeObservability {
  const stateSlot = options.stateSlot ?? DEFAULT_STATE_SLOT
  const reportSlot = options.reportSlot ?? DEFAULT_REPORT_SLOT
  const saveDelayMs = positiveInteger(options.saveDelayMs ?? 1_000)
  const now = options.now ?? Date.now
  const startedAt = isoTimestamp(now())
  const state = loadState(options.persistence, stateSlot, startedAt)
  state.launchCount += 1
  state.lastStartedAt = startedAt
  let lastWorkerEpoch: string | number | undefined
  let lastWorkerSnapshot: MemoryV4RuntimeWorkerSnapshot | undefined

  function report(): MemoryV4RuntimeReport {
    const generatedAt = isoTimestamp(now())
    return {
      version: MEMORY_V4_RUNTIME_REPORT_VERSION,
      observabilityVersion: MEMORY_V4_RUNTIME_OBSERVABILITY_VERSION,
      generatedAt,
      launchCount: state.launchCount,
      lastStartedAt: state.lastStartedAt,
      ...(state.firstObservedAt ? { firstObservedAt: state.firstObservedAt } : {}),
      ...(state.lastObservedAt ? { lastObservedAt: state.lastObservedAt } : {}),
      total: rollupReport(state.total),
      days: Object.entries(state.days)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([day, rollup]) => ({ day, ...rollupReport(rollup) })),
      worker: cloneWorkerSnapshot(state.workerTotals),
      ...(state.lastIndex ? { index: { ...state.lastIndex } } : {}),
      ...(state.lastMemory ? { memory: { ...state.lastMemory } } : {}),
      ...(state.lastPolicy ? { policy: { ...state.lastPolicy } } : {}),
      ...(state.last ? { last: { ...state.last } } : {}),
    }
  }

  function scheduleSave(): void {
    try {
      options.persistence.saveJsonDebounced(stateSlot, cloneState(state), saveDelayMs)
      options.persistence.saveJsonDebounced(reportSlot, report(), saveDelayMs)
    }
    catch {
      // Operational telemetry must never affect memory reads or app startup.
    }
  }

  scheduleSave()

  return {
    record(decision, context = {}) {
      const observedAt = isoTimestamp(now())
      const recoveredFrom = decision.authoritativeReadSource === 'v4'
        && state.last?.authoritativeReadSource === 'v3'
        ? state.last.fallbackReason
        : undefined
      state.firstObservedAt ??= observedAt
      state.lastObservedAt = observedAt
      addDecision(state.total, decision, recoveredFrom)
      const day = observedAt.slice(0, 10)
      const daily = state.days[day] ?? createCounterRollup()
      addDecision(daily, decision, recoveredFrom)
      state.days[day] = daily
      trimDays(state.days)
      if (context.worker) {
        if (context.workerEpoch !== undefined && context.workerEpoch !== lastWorkerEpoch)
          lastWorkerSnapshot = undefined
        lastWorkerEpoch = context.workerEpoch
        lastWorkerSnapshot = mergeWorkerCounters(state, context.worker, lastWorkerSnapshot)
      }
      if (context.workerAvailable === false)
        state.lastIndex = undefined
      if (context.memoryAvailable === false)
        state.lastMemory = undefined
      if (context.index)
        state.lastIndex = sanitizeIndexSnapshot(context.index)
      if (context.memory)
        state.lastMemory = sanitizeMemorySnapshot(context.memory)
      if (decision.evidenceBundle)
        state.lastPolicy = { ...decision.evidenceBundle.retrievalPolicy }
      state.last = {
        observedAt,
        requestedMode: decision.requestedMode,
        authoritativeReadSource: decision.authoritativeReadSource,
        ...(decision.fallbackReason ? { fallbackReason: decision.fallbackReason } : {}),
        latencyMs: nonNegativeNumber(decision.latencyMs),
        candidateCount: nonNegativeInteger(decision.result.candidateCount),
        selectedEvidenceCount: decision.evidenceBundle?.entries.length ?? 0,
        ...(decision.evidenceBundle
          ? { snapshotRevision: nonNegativeInteger(decision.evidenceBundle.snapshotRevision) }
          : {}),
      }
      scheduleSave()
    },
    status: report,
  }
}

function addDecision(
  rollup: CounterRollupState,
  decision: MemoryV4ReadDecision,
  recoveredFrom?: MemoryV4ReadFallbackReason,
): void {
  rollup.reads += 1
  if (decision.authoritativeReadSource === 'v4')
    rollup.v4Reads += 1
  else
    rollup.v3Reads += 1
  rollup.requestedModes[decision.requestedMode] += 1
  if (decision.fallbackReason) {
    rollup.fallbacks += 1
    rollup.fallbackReasons[decision.fallbackReason]
      = (rollup.fallbackReasons[decision.fallbackReason] ?? 0) + 1
  }
  if (recoveredFrom) {
    rollup.recoveries += 1
    rollup.recoveryReasons[recoveredFrom] = (rollup.recoveryReasons[recoveredFrom] ?? 0) + 1
  }
  const latencyMs = nonNegativeNumber(decision.latencyMs)
  rollup.latencyTotalMs += latencyMs
  rollup.latencySamples.push(latencyMs)
  if (rollup.latencySamples.length > MAX_LATENCY_SAMPLES)
    rollup.latencySamples.splice(0, rollup.latencySamples.length - MAX_LATENCY_SAMPLES)
  const candidateCount = nonNegativeInteger(decision.result.candidateCount)
  const selectedEvidenceCount = decision.evidenceBundle?.entries.length ?? 0
  rollup.candidateTotal += candidateCount
  rollup.candidateMax = Math.max(rollup.candidateMax, candidateCount)
  rollup.selectedEvidenceTotal += selectedEvidenceCount
  rollup.selectedEvidenceMax = Math.max(rollup.selectedEvidenceMax, selectedEvidenceCount)
}

function rollupReport(state: CounterRollupState): MemoryV4RuntimeCounterReport {
  const orderedLatency = state.latencySamples
    .map(nonNegativeNumber)
    .sort((left, right) => left - right)
  const averageLatency = orderedLatency.length > 0
    ? orderedLatency.reduce((sum, value) => sum + value, 0) / orderedLatency.length
    : 0
  const p95 = percentile(orderedLatency, 0.95)
  const attemptedFallbacks = (state.fallbackReasons['v4-error'] ?? 0)
    + (state.fallbackReasons['v4-empty'] ?? 0)
    + (state.fallbackReasons['v4-abstained'] ?? 0)
  const v4Attempts = state.v4Reads + attemptedFallbacks
  return {
    reads: state.reads,
    readSources: { v3: state.v3Reads, v4: state.v4Reads },
    requestedModes: { ...state.requestedModes },
    v4ReadRate: ratio(state.v4Reads, state.reads),
    fallbacks: {
      total: state.fallbacks,
      rate: ratio(state.fallbacks, state.reads),
      reasons: { ...state.fallbackReasons },
    },
    recoveries: {
      total: state.recoveries,
      fromReasons: { ...state.recoveryReasons },
    },
    v4Attempts,
    v4EvidenceSufficientRate: ratio(state.v4Reads, v4Attempts),
    latencyMs: {
      samples: orderedLatency.length,
      average: rounded(averageLatency),
      p50: rounded(percentile(orderedLatency, 0.50)),
      p95: rounded(p95),
      p99: rounded(percentile(orderedLatency, 0.99)),
      max: rounded(orderedLatency.at(-1) ?? 0),
      targetP95Ms: MEMORY_V4_RUNTIME_LATENCY_TARGET_MS,
      targetMet: orderedLatency.length === 0 || p95 < MEMORY_V4_RUNTIME_LATENCY_TARGET_MS,
    },
    candidateCount: {
      average: rounded(state.reads > 0 ? state.candidateTotal / state.reads : 0),
      max: state.candidateMax,
    },
    selectedEvidenceCount: {
      average: rounded(state.reads > 0 ? state.selectedEvidenceTotal / state.reads : 0),
      max: state.selectedEvidenceMax,
    },
  }
}

function loadState(persistence: JsonPersistence, slot: string, startedAt: string): MemoryV4RuntimeStoredState {
  const fallback = createState(startedAt)
  try {
    return normalizeState(persistence.loadJson<unknown>(slot, fallback), startedAt)
  }
  catch {
    return fallback
  }
}

function normalizeState(value: unknown, startedAt: string): MemoryV4RuntimeStoredState {
  if (!value || typeof value !== 'object')
    return createState(startedAt)
  const source = value as Partial<MemoryV4RuntimeStoredState>
  if (source.version !== MEMORY_V4_RUNTIME_OBSERVABILITY_VERSION)
    return createState(startedAt)
  const days: Record<string, CounterRollupState> = {}
  if (source.days && typeof source.days === 'object') {
    for (const [day, rollup] of Object.entries(source.days)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(day))
        days[day] = normalizeRollup(rollup)
    }
  }
  trimDays(days)
  return {
    version: MEMORY_V4_RUNTIME_OBSERVABILITY_VERSION,
    launchCount: nonNegativeInteger(source.launchCount),
    lastStartedAt: validTimestamp(source.lastStartedAt) ?? startedAt,
    ...(validTimestamp(source.firstObservedAt) ? { firstObservedAt: source.firstObservedAt } : {}),
    ...(validTimestamp(source.lastObservedAt) ? { lastObservedAt: source.lastObservedAt } : {}),
    total: normalizeRollup(source.total),
    days,
    workerTotals: sanitizeWorkerSnapshot(source.workerTotals),
    ...(source.lastIndex ? { lastIndex: sanitizeIndexSnapshot(source.lastIndex) } : {}),
    ...(source.lastMemory ? { lastMemory: sanitizeMemorySnapshot(source.lastMemory) } : {}),
    ...(validPolicy(source.lastPolicy) ? { lastPolicy: { ...source.lastPolicy } } : {}),
    ...(validLastRead(source.last) ? { last: { ...source.last } } : {}),
  }
}

function createState(startedAt: string): MemoryV4RuntimeStoredState {
  return {
    version: MEMORY_V4_RUNTIME_OBSERVABILITY_VERSION,
    launchCount: 0,
    lastStartedAt: startedAt,
    total: createCounterRollup(),
    days: {},
    workerTotals: emptyWorkerSnapshot(),
  }
}

function createCounterRollup(): CounterRollupState {
  return {
    reads: 0,
    v3Reads: 0,
    v4Reads: 0,
    fallbacks: 0,
    fallbackReasons: {},
    recoveries: 0,
    recoveryReasons: {},
    requestedModes: { v3: 0, 'v4-beta': 0, auto: 0 },
    latencyTotalMs: 0,
    latencySamples: [],
    candidateTotal: 0,
    candidateMax: 0,
    selectedEvidenceTotal: 0,
    selectedEvidenceMax: 0,
  }
}

function normalizeRollup(value: unknown): CounterRollupState {
  const fallback = createCounterRollup()
  if (!value || typeof value !== 'object')
    return fallback
  const source = value as Partial<CounterRollupState>
  const latencySamples = Array.isArray(source.latencySamples)
    ? source.latencySamples.slice(-MAX_LATENCY_SAMPLES).map(nonNegativeNumber)
    : []
  return {
    reads: nonNegativeInteger(source.reads),
    v3Reads: nonNegativeInteger(source.v3Reads),
    v4Reads: nonNegativeInteger(source.v4Reads),
    fallbacks: nonNegativeInteger(source.fallbacks),
    fallbackReasons: normalizeFallbackReasons(source.fallbackReasons),
    recoveries: nonNegativeInteger(source.recoveries),
    recoveryReasons: normalizeFallbackReasons(source.recoveryReasons),
    requestedModes: {
      v3: nonNegativeInteger(source.requestedModes?.v3),
      'v4-beta': nonNegativeInteger(source.requestedModes?.['v4-beta']),
      auto: nonNegativeInteger(source.requestedModes?.auto),
    },
    latencyTotalMs: nonNegativeNumber(source.latencyTotalMs),
    latencySamples,
    candidateTotal: nonNegativeInteger(source.candidateTotal),
    candidateMax: nonNegativeInteger(source.candidateMax),
    selectedEvidenceTotal: nonNegativeInteger(source.selectedEvidenceTotal),
    selectedEvidenceMax: nonNegativeInteger(source.selectedEvidenceMax),
  }
}

function normalizeFallbackReasons(
  value: unknown,
): Partial<Record<MemoryV4ReadFallbackReason, number>> {
  if (!value || typeof value !== 'object')
    return {}
  const source = value as Partial<Record<MemoryV4ReadFallbackReason, unknown>>
  const result: Partial<Record<MemoryV4ReadFallbackReason, number>> = {}
  for (const reason of ['v4-unavailable', 'v4-not-ready', 'v4-error', 'v4-empty', 'v4-abstained'] as const) {
    const count = nonNegativeInteger(source[reason])
    if (count > 0)
      result[reason] = count
  }
  return result
}

function mergeWorkerCounters(
  state: MemoryV4RuntimeStoredState,
  input: MemoryV4RuntimeWorkerSnapshot,
  previous: MemoryV4RuntimeWorkerSnapshot | undefined,
): MemoryV4RuntimeWorkerSnapshot {
  const current = sanitizeWorkerSnapshot(input)
  for (const key of workerCounterKeys) {
    const delta = previous && current[key] >= previous[key]
      ? current[key] - previous[key]
      : current[key]
    state.workerTotals[key] += delta
  }
  return current
}

const workerCounterKeys = [
  'starts',
  'restarts',
  'requests',
  'completed',
  'failures',
  'timeouts',
  'cancellations',
  'snapshotSyncs',
  'semanticSyncs',
] as const

function emptyWorkerSnapshot(): MemoryV4RuntimeWorkerSnapshot {
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

function sanitizeWorkerSnapshot(value: unknown): MemoryV4RuntimeWorkerSnapshot {
  const source = value && typeof value === 'object'
    ? value as Partial<MemoryV4RuntimeWorkerSnapshot>
    : {}
  return Object.fromEntries(
    workerCounterKeys.map(key => [key, nonNegativeInteger(source[key])]),
  ) as unknown as MemoryV4RuntimeWorkerSnapshot
}

function cloneWorkerSnapshot(value: MemoryV4RuntimeWorkerSnapshot): MemoryV4RuntimeWorkerSnapshot {
  return { ...value }
}

function sanitizeIndexSnapshot(value: MemoryV4RuntimeIndexSnapshot): MemoryV4RuntimeIndexSnapshot {
  return {
    revision: nonNegativeInteger(value.revision),
    summaries: nonNegativeInteger(value.summaries),
    facts: nonNegativeInteger(value.facts),
    rebuildCount: nonNegativeInteger(value.rebuildCount),
    ...(value.semanticFacts === undefined ? {} : { semanticFacts: nonNegativeInteger(value.semanticFacts) }),
    ...(value.semanticSummaries === undefined ? {} : { semanticSummaries: nonNegativeInteger(value.semanticSummaries) }),
  }
}

function sanitizeMemorySnapshot(value: MemoryV4RuntimeMemorySnapshot): MemoryV4RuntimeMemorySnapshot {
  return {
    revision: nonNegativeInteger(value.revision),
    facts: nonNegativeInteger(value.facts),
    factVersions: nonNegativeInteger(value.factVersions),
    derivedArtifacts: nonNegativeInteger(value.derivedArtifacts),
  }
}

function cloneState(state: MemoryV4RuntimeStoredState): MemoryV4RuntimeStoredState {
  return {
    ...state,
    total: cloneRollup(state.total),
    days: Object.fromEntries(Object.entries(state.days).map(([day, rollup]) => [day, cloneRollup(rollup)])),
    workerTotals: cloneWorkerSnapshot(state.workerTotals),
    ...(state.lastIndex ? { lastIndex: { ...state.lastIndex } } : {}),
    ...(state.lastMemory ? { lastMemory: { ...state.lastMemory } } : {}),
    ...(state.lastPolicy ? { lastPolicy: { ...state.lastPolicy } } : {}),
    ...(state.last ? { last: { ...state.last } } : {}),
  }
}

function cloneRollup(value: CounterRollupState): CounterRollupState {
  return {
    ...value,
    fallbackReasons: { ...value.fallbackReasons },
    recoveryReasons: { ...value.recoveryReasons },
    requestedModes: { ...value.requestedModes },
    latencySamples: [...value.latencySamples],
  }
}

function trimDays(days: Record<string, CounterRollupState>): void {
  const ordered = Object.keys(days).sort()
  for (const day of ordered.slice(0, Math.max(0, ordered.length - MAX_DAILY_REPORTS)))
    delete days[day]
}

function validPolicy(value: unknown): value is { policyId: string; policyVersion: string; fingerprint: string } {
  if (!value || typeof value !== 'object')
    return false
  const source = value as Record<string, unknown>
  return typeof source.policyId === 'string'
    && typeof source.policyVersion === 'string'
    && typeof source.fingerprint === 'string'
}

function validLastRead(value: unknown): value is MemoryV4RuntimeLastRead {
  if (!value || typeof value !== 'object')
    return false
  const source = value as Partial<MemoryV4RuntimeLastRead>
  return validTimestamp(source.observedAt) !== undefined
    && (source.requestedMode === 'v3' || source.requestedMode === 'v4-beta' || source.requestedMode === 'auto')
    && (source.authoritativeReadSource === 'v3' || source.authoritativeReadSource === 'v4')
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0)
    return 0
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1)
  return sorted[index] ?? 0
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? rounded(numerator / denominator) : 0
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, value)
    : 0
}

function positiveInteger(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : 1
}

function isoTimestamp(value: number): string {
  return new Date(Number.isFinite(value) ? value : Date.now()).toISOString()
}

function validTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)))
    return undefined
  return value
}
