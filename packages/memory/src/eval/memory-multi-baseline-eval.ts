import type {
  MemoryFragment,
  MemoryRecallOptions,
  MemoryScope,
  MemoryTemporalMode,
} from '@continuum-memory/contracts'
import { createMemoryBm25Index } from '../long-term/bm25-index'
import { createDenseVectorCandidateIndex } from '../long-term/dense-vector-candidate-index'
import { createLocalEmbedding, LOCAL_EMBEDDING_MODEL } from '../long-term/local-embedding'
import { planMemoryQuery, type MemoryQueryPlan } from '../long-term/memory-query-planner'
import {
  createVectorStore,
  type V3MemoryRecord,
} from '../long-term/vector-store'
import { createMemoryConsolidationService } from '../v4/consolidation/memory-consolidation-service'
import { migrateV3PayloadToV4 } from '../v4/migration/v3-to-v4'
import { createMemoryV4Repository } from '../v4/repository/memory-v4-repository'
import { createMemoryV4ShadowRetriever } from '../v4/retrieval/memory-v4-shadow-retriever'
import {
  runMemoryStage3RetrievalEval,
  type MemoryStage3RetrievalEvalCase,
  type MemoryStage3RetrievalEvalReport,
} from './stage3-retrieval-eval'
import { fingerprintJson } from './blind-pack-common'

export const MEMORY_MULTI_BASELINE_EVAL_VERSION = 'memory-multi-baseline-eval-v1'
export const MEMORY_MULTI_BASELINE_GATE_VERSION = 'memory-multi-baseline-gate-v1'

export const MEMORY_MULTI_BASELINE_STRATEGIES = [
  'no-memory',
  'bm25',
  'dense-local-hash',
  'v3-hybrid-rrf',
  'v4-hierarchical',
  'oracle',
] as const

export type MemoryMultiBaselineStrategy = typeof MEMORY_MULTI_BASELINE_STRATEGIES[number]

export interface MemoryMultiBaselineFact {
  key: string
  content: string
  kind: string
  importance?: number
  memoryKey?: string
  validFrom?: string
  suppressAfterWrite?: boolean
}

export interface MemoryMultiBaselineCase {
  id: string
  category: string
  query: string
  relevantKeys: string[]
  temporalMode?: MemoryTemporalMode
}

export interface MemoryMultiBaselineFixture {
  datasetVersion: string
  facts: MemoryMultiBaselineFact[]
  cases: MemoryMultiBaselineCase[]
}

export interface MemoryMultiBaselineEvalOptions {
  topK?: number
  noiseCount?: number
  now?: () => number
}

export interface MemoryMultiBaselineEvalReport {
  evalVersion: typeof MEMORY_MULTI_BASELINE_EVAL_VERSION
  datasetVersion: string
  datasetFingerprint: string
  evaluatedAt: number
  note: string
  topK: number
  caseCount: number
  factCount: number
  noiseCount: number
  corpusItemCount: number
  strategies: Record<MemoryMultiBaselineStrategy, MemoryStage3RetrievalEvalReport>
  qualityGates: Record<MemoryMultiBaselineStrategy, MemoryMultiBaselineGateResult>
}

export interface MemoryMultiBaselineGateCheck {
  metric: 'recallAtK' | 'top1Accuracy' | 'ndcgAtK' | 'abstentionAccuracy'
  actual: number
  minimum: number
  passed: boolean
}

export interface MemoryMultiBaselineGateResult {
  version: typeof MEMORY_MULTI_BASELINE_GATE_VERSION
  passed: boolean
  checks: MemoryMultiBaselineGateCheck[]
}

interface CapturedV3Snapshot {
  version: 3
  items: V3MemoryRecord[]
}

interface PreparedCorpus {
  payload: string
  records: V3MemoryRecord[]
  store: ReturnType<typeof createVectorStore>
  scope: MemoryScope & { ownerId: string; agentId: string }
}

type Retriever = (
  query: string,
  topK: number,
  options?: MemoryRecallOptions,
) => Promise<MemoryFragment[]>

/**
 * Compare lower bounds, isolated retrieval routes, V3, V4 and an oracle on one
 * frozen corpus. This development evaluator deliberately excludes answer
 * generation so it measures memory selection rather than language-model skill.
 */
export async function runMemoryMultiBaselineEval(
  fixture: MemoryMultiBaselineFixture,
  options: MemoryMultiBaselineEvalOptions = {},
): Promise<MemoryMultiBaselineEvalReport> {
  validateFixture(fixture)
  const topK = clampInteger(options.topK, 1, 20, 5)
  const noiseCount = clampInteger(options.noiseCount, 0, 20_000, 250)
  const now = options.now ?? Date.now
  const evaluatedAt = now()
  const corpus = prepareCorpus(fixture, noiseCount, evaluatedAt)
  const cases = fixture.cases.map(toRetrievalCase)
  const retrievers = await prepareRetrievers(fixture, corpus, now)
  const strategies = {} as Record<MemoryMultiBaselineStrategy, MemoryStage3RetrievalEvalReport>

  for (const strategy of MEMORY_MULTI_BASELINE_STRATEGIES) {
    strategies[strategy] = await runMemoryStage3RetrievalEval(cases, retrievers[strategy], {
      datasetVersion: fixture.datasetVersion,
      topK,
    })
  }

  return {
    evalVersion: MEMORY_MULTI_BASELINE_EVAL_VERSION,
    datasetVersion: fixture.datasetVersion,
    datasetFingerprint: fingerprintMemoryMultiBaselineFixture(fixture),
    evaluatedAt,
    note: 'Repository-visible development set; retrieval-only and not an external blind result.',
    topK,
    caseCount: fixture.cases.length,
    factCount: fixture.facts.length,
    noiseCount,
    corpusItemCount: corpus.records.length,
    strategies,
    qualityGates: Object.fromEntries(MEMORY_MULTI_BASELINE_STRATEGIES.map(strategy => [
      strategy,
      evaluateQualityGate(strategies[strategy]),
    ])) as Record<MemoryMultiBaselineStrategy, MemoryMultiBaselineGateResult>,
  }
}

export function fingerprintMemoryMultiBaselineFixture(fixture: MemoryMultiBaselineFixture): string {
  validateFixture(fixture)
  return fingerprintJson(fixture)
}

export function evaluateMemoryMultiBaselineGate(
  report: MemoryStage3RetrievalEvalReport,
): MemoryMultiBaselineGateResult {
  return evaluateQualityGate(report)
}

function evaluateQualityGate(report: MemoryStage3RetrievalEvalReport): MemoryMultiBaselineGateResult {
  const requirements: Array<[MemoryMultiBaselineGateCheck['metric'], number]> = [
    ['recallAtK', 0.9],
    ['top1Accuracy', 0.85],
    ['ndcgAtK', 0.85],
    ['abstentionAccuracy', 0.95],
  ]
  const checks = requirements.map(([metric, minimum]): MemoryMultiBaselineGateCheck => ({
    metric,
    actual: report[metric],
    minimum,
    passed: report[metric] >= minimum,
  }))
  return {
    version: MEMORY_MULTI_BASELINE_GATE_VERSION,
    passed: checks.every(check => check.passed),
    checks,
  }
}

function prepareCorpus(
  fixture: MemoryMultiBaselineFixture,
  noiseCount: number,
  evaluationNow: number,
): PreparedCorpus {
  const scope = { ownerId: 'multi-baseline-eval-user', agentId: 'deskpet' }
  const records = fixture.facts.map((fact, index): V3MemoryRecord => {
    const validFrom = fact.validFrom ? parseTimestamp(fact.validFrom, fact.key) : undefined
    const createdAt = validFrom ?? evaluationNow - (fixture.facts.length - index) * 1_000
    return {
      id: `eval:${fact.key}`,
      content: fact.content,
      metadata: {
        evalKey: fact.key,
        kind: fact.kind,
        ...(fact.memoryKey ? { memoryKey: fact.memoryKey, cardinality: 'single' } : {}),
      },
      status: fact.suppressAfterWrite ? 'suppressed' : 'active',
      origin: 'manual',
      importance: fact.importance ?? 0.85,
      confidence: 0.95,
      accessCount: 0,
      ...(validFrom === undefined ? {} : { validFrom }),
      ...(fact.memoryKey ? { memoryKey: fact.memoryKey } : {}),
      sourceMessageIds: [`eval-source:${fact.key}`],
      sourceAttachmentIds: [],
      sharePolicy: 'allow-remote',
      sensitivity: 'normal',
      scope: { ...scope },
      embedding: createLocalEmbedding(fact.content),
      embeddingModel: LOCAL_EMBEDDING_MODEL,
      createdAt,
      updatedAt: createdAt,
    }
  })
  closeHistoricalVersions(records)
  for (let index = 0; index < noiseCount; index++) {
    const content = `归档干扰记录 ${index}：通用事项编号 noise-${index}`
    const createdAt = evaluationNow - noiseCount + index
    records.push({
      id: `eval:noise-${index}`,
      content,
      metadata: { evalKey: `noise-${index}`, kind: `noise-${index}` },
      status: 'active',
      origin: 'manual',
      importance: 0.2,
      confidence: 0.7,
      accessCount: 0,
      sourceMessageIds: [`eval-source:noise-${index}`],
      sourceAttachmentIds: [],
      sharePolicy: 'allow-remote',
      sensitivity: 'normal',
      scope: { ...scope },
      embedding: createLocalEmbedding(content),
      embeddingModel: LOCAL_EMBEDDING_MODEL,
      createdAt,
      updatedAt: createdAt,
    })
  }
  const snapshot: CapturedV3Snapshot = { version: 3, items: records }
  const payload = JSON.stringify(snapshot)
  const store = createVectorStore({
    persistence: { load: () => payload, save: () => undefined },
    retrievalFusion: 'rrf-v1',
  })
  return { payload, records, store, scope }
}

function closeHistoricalVersions(records: V3MemoryRecord[]): void {
  const groups = new Map<string, V3MemoryRecord[]>()
  for (const record of records) {
    if (!record.memoryKey || record.validFrom === undefined || record.status !== 'active')
      continue
    const group = groups.get(record.memoryKey) ?? []
    group.push(record)
    groups.set(record.memoryKey, group)
  }
  for (const group of groups.values()) {
    group.sort((left, right) => left.validFrom! - right.validFrom!)
    for (let index = 0; index < group.length; index++) {
      const record = group[index]!
      const previous = group[index - 1]
      const next = group[index + 1]
      if (previous)
        record.supersedes = previous.id
      if (!next)
        continue
      record.status = 'superseded'
      record.validTo = next.validFrom
      record.invalidatedAt = next.createdAt
      record.updatedAt = next.createdAt
    }
  }
}

async function prepareRetrievers(
  fixture: MemoryMultiBaselineFixture,
  corpus: PreparedCorpus,
  now: () => number,
): Promise<Record<MemoryMultiBaselineStrategy, Retriever>> {
  const recordsById = new Map(corpus.records.map(record => [record.id, record]))
  const recordsByKey = new Map(corpus.records.flatMap((record) => {
    const key = evalKey(record)
    return key ? [[key, record] as const] : []
  }))

  const bm25 = createMemoryBm25Index()
  const dense = createDenseVectorCandidateIndex()
  for (const record of corpus.records) {
    if (!isSearchableStatus(record.status))
      continue
    bm25.upsert({
      id: record.id,
      content: record.content,
      scope: record.scope,
      state: record.status === 'active' ? 'active' : 'historical',
    })
    dense.upsert(record.id, createLocalEmbedding(record.content))
  }

  const repository = createMemoryV4Repository({ now })
  repository.replace(migrateV3PayloadToV4(corpus.payload, { now }))
  await createMemoryConsolidationService(repository, { now }).consolidate(corpus.scope, {
    granularity: ['session', 'day', 'topic', 'entity', 'stage'],
    maxBuckets: 10_000,
    maxRuntimeMs: 60_000,
  })
  const v4 = createMemoryV4ShadowRetriever(repository, { now })
  const v4Snapshot = repository.snapshot()
  const v4RecordIds = new Map(v4Snapshot.legacyImports.map(item => [item.factId, item.sourceItemId]))
  const casesByQuery = new Map(fixture.cases.map(testCase => [testCase.query, testCase]))

  return {
    'no-memory': async () => [],
    bm25: async (query, topK, recallOptions) => {
      const plan = planMemoryQuery(query, recallOptions)
      if (!plan.requiresMemory)
        return []
      return bm25.search(query, {
        scope: corpus.scope,
        mode: plan.temporalMode === 'current' ? 'current' : 'historical',
        limit: topK,
        minScore: 0.08,
        allow: id => temporalEligible(recordsById.get(id), plan, now()),
      }).flatMap(hit => recordsById.get(hit.id)
        ? [toFragment(recordsById.get(hit.id)!, hit.score)]
        : [])
    },
    'dense-local-hash': async (query, topK, recallOptions) => {
      const plan = planMemoryQuery(query, recallOptions)
      if (!plan.requiresMemory)
        return []
      return dense.search(createLocalEmbedding(query), {
        limit: topK,
        minScore: 0.2,
        allow: id => temporalEligible(recordsById.get(id), plan, now()),
      }).flatMap(hit => recordsById.get(hit.id)
        ? [toFragment(recordsById.get(hit.id)!, hit.score)]
        : [])
    },
    'v3-hybrid-rrf': (query, topK, recallOptions) =>
      corpus.store.recall(query, corpus.scope, topK, recallOptions),
    'v4-hierarchical': async (query, topK, recallOptions) => v4.recall(query, {
      scope: corpus.scope,
      limit: topK,
      ...(recallOptions?.temporalMode ? { temporalMode: recallOptions.temporalMode } : {}),
      ...(recallOptions?.asOf !== undefined ? { asOf: recallOptions.asOf } : {}),
      ...(recallOptions?.sharePolicies ? { sharePolicies: recallOptions.sharePolicies } : {}),
      ...(recallOptions?.sensitivities ? { sensitivities: recallOptions.sensitivities } : {}),
    }).hits.flatMap((hit) => {
      const sourceId = hit.sourceMemoryId ?? v4RecordIds.get(hit.factId)
      const record = sourceId ? recordsById.get(sourceId) : undefined
      return record ? [toFragment(record, hit.score)] : []
    }),
    oracle: async (query, topK) => {
      const testCase = casesByQuery.get(query)
      if (!testCase)
        throw new Error(`Oracle has no truth row for query: ${query}`)
      return testCase.relevantKeys.slice(0, topK).flatMap(key => recordsByKey.get(key)
        ? [toFragment(recordsByKey.get(key)!, 1)]
        : [])
    },
  }
}

function toRetrievalCase(testCase: MemoryMultiBaselineCase): MemoryStage3RetrievalEvalCase {
  return {
    id: testCase.id,
    category: testCase.category,
    query: testCase.query,
    relevantKeys: [...testCase.relevantKeys],
    ...(testCase.temporalMode ? { options: { temporalMode: testCase.temporalMode } } : {}),
  }
}

function temporalEligible(
  record: V3MemoryRecord | undefined,
  plan: MemoryQueryPlan,
  now: number,
): boolean {
  if (!record || !isSearchableStatus(record.status))
    return false
  if (plan.validBetween) {
    const start = record.validFrom ?? Number.NEGATIVE_INFINITY
    const end = record.validTo ?? Number.POSITIVE_INFINITY
    return start < plan.validBetween.to && end > plan.validBetween.from
  }
  const reference = plan.asOf ?? now
  const valid = (record.validFrom === undefined || record.validFrom <= reference)
    && (record.validTo === undefined || reference < record.validTo)
  if (plan.temporalMode === 'current')
    return record.status === 'active' && valid
  if (plan.asOf !== undefined)
    return valid
  return true
}

function isSearchableStatus(status: V3MemoryRecord['status']): boolean {
  return status === 'active' || status === 'superseded'
}

function toFragment(record: V3MemoryRecord, score: number): MemoryFragment {
  return {
    id: record.id,
    content: record.content,
    score,
    metadata: record.metadata,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    status: record.status,
    validFrom: record.validFrom,
    validTo: record.validTo,
  }
}

function evalKey(record: V3MemoryRecord): string | undefined {
  const value = record.metadata?.evalKey
  return typeof value === 'string' && value ? value : undefined
}

function validateFixture(fixture: MemoryMultiBaselineFixture): void {
  if (!fixture.datasetVersion.trim())
    throw new Error('Multi-baseline datasetVersion is required')
  assertUnique(fixture.facts.map(fact => fact.key), 'fact key')
  assertUnique(fixture.cases.map(testCase => testCase.id), 'case id')
  assertUnique(fixture.cases.map(testCase => testCase.query), 'case query')
  const facts = new Set(fixture.facts.map(fact => fact.key))
  for (const testCase of fixture.cases) {
    for (const key of testCase.relevantKeys) {
      if (!facts.has(key))
        throw new Error(`Case ${testCase.id} references unknown fact key: ${key}`)
    }
  }
}

function assertUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>()
  for (const value of values) {
    if (!value.trim())
      throw new Error(`Multi-baseline ${label} is required`)
    if (seen.has(value))
      throw new Error(`Duplicate multi-baseline ${label}: ${value}`)
    seen.add(value)
  }
}

function parseTimestamp(value: string, factKey: string): number {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp))
    throw new Error(`Fact ${factKey} has an invalid validFrom timestamp`)
  return timestamp
}

function clampInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, Math.floor(value)))
    : fallback
}
