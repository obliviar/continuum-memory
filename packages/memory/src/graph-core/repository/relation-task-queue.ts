import { createHash } from 'node:crypto'
import type { GraphClaimRef, GraphScope } from '@continuum-memory/contracts'
import { createLocalHashEmbedding } from '../../long-term/local-embedding'
import type { GraphClaimRecord, GraphPredicateSpec } from '../domain/types'
import type { GraphRelationRecord } from '../domain/relation-types'
import { selectGraphRelationPairSeeds, type GraphRelationPairSeed } from '../domain/relation-candidates'

export const GRAPH_RELATION_PREPROCESSING_VERSION = 'graph-relation-evidence-v1'
export interface GraphRelationJudgementTask {
  readonly key: string
  readonly claims: readonly [GraphClaimRef, GraphClaimRef]
  readonly modelId: string
  readonly modelRevision: string
  readonly preprocessingVersion: string
  readonly routes: readonly GraphRelationPairSeed['route'][]
  readonly status: 'pending' | 'completed' | 'stale'
  readonly createdAt: number
  readonly attempts?: number
  readonly nextAttemptAt?: number
  readonly lastError?: string
  readonly result?: {
    readonly label: 'CONTRADICTION' | 'NEUTRAL' | 'ENTAILMENT'
    readonly scores?: Readonly<Record<'CONTRADICTION' | 'NEUTRAL' | 'ENTAILMENT', number>>
    readonly premiseHash?: string
    readonly hypothesisHash?: string
    readonly truncated?: boolean
    readonly evaluatedAt: number
  }
}
export interface GraphRelationTaskPersistence {
  load: () => string | undefined
  save: (payload: string) => void
}
export interface GraphRelationTaskQueue {
  snapshot: () => readonly GraphRelationJudgementTask[]
  /** Reconciles newly published exact Claim versions; persists tasks before acknowledging the L1 publication. */
  sync: (claims: readonly GraphClaimRecord[], predicates: readonly GraphPredicateSpec[], scope: GraphScope,
    sourceText: (claim: GraphClaimRecord) => string,
    relations?: readonly GraphRelationRecord[]) => number
  complete: (key: string, result: NonNullable<GraphRelationJudgementTask['result']>) => void
  fail: (key: string, error: string, nextAttemptAt: number) => void
  ready: (now?: number) => readonly GraphRelationJudgementTask[]
  nextRetryAt: () => number | undefined
}

export function graphRelationPairKey(a: GraphClaimRef, b: GraphClaimRef,
  modelId: string, modelRevision: string, preprocessingVersion: string): string {
  const refs = [a, b].map(ref => `${ref.kind}\0${ref.id}\0${ref.version}`)
  return createHash('sha256').update(JSON.stringify([refs, modelId, modelRevision, preprocessingVersion])).digest('hex')
}

export function createGraphRelationTaskQueue(persistence: GraphRelationTaskPersistence,
  options: { modelId: string; modelRevision: string; preprocessingVersion?: string;
    maxCandidates?: number; maxDenseSeeds?: number } ): GraphRelationTaskQueue {
  const preprocessingVersion = options.preprocessingVersion ?? GRAPH_RELATION_PREPROCESSING_VERSION
  const loaded = persistence.load()
  const state = loaded ? JSON.parse(loaded) as { version: number; tasks: GraphRelationJudgementTask[]; processed: string[] }
    : { version: 1, tasks: [], processed: [] }
  if (state.version !== 1 || !Array.isArray(state.tasks) || !Array.isArray(state.processed))
    throw new Error('Invalid graph relation task queue')
  const tasks = new Map(state.tasks.map(task => [task.key, task]))
  const processed = new Set(state.processed)
  const persist = (): void => persistence.save(JSON.stringify({ version: 1, tasks: [...tasks.values()], processed: [...processed] }))
  return {
    snapshot: () => structuredClone([...tasks.values()]),
    ready: (now = Date.now()) => structuredClone([...tasks.values()].filter(task => task.status === 'pending'
      && (task.nextAttemptAt ?? 0) <= now)),
    nextRetryAt: () => [...tasks.values()].filter(task => task.status === 'pending'
      && (task.nextAttemptAt ?? 0) > Date.now()).reduce<number | undefined>((next, task) =>
        next === undefined ? task.nextAttemptAt : Math.min(next, task.nextAttemptAt!), undefined),
    fail(key, error, nextAttemptAt) {
      const task = tasks.get(key)
      if (!task || task.status !== 'pending') return
      const next = { ...task, attempts: (task.attempts ?? 0) + 1,
        nextAttemptAt, lastError: error.slice(0, 300) }
      tasks.set(key, next)
      try { persist() } catch (cause) { tasks.set(key, task); throw cause }
    },
    complete(key, result) {
      const task = tasks.get(key)
      if (!task) throw new Error('Unknown graph relation judgement task')
      if (task.status === 'stale') throw new Error('Graph relation judgement task has stale Claim references')
      if (task.status === 'completed') return
      if (result.scores) {
        const scores = Object.values(result.scores)
        if (scores.length !== 3 || scores.some(score => !Number.isFinite(score) || score < 0 || score > 1)
          || Math.abs(scores.reduce((sum, score) => sum + score, 0) - 1) > 0.001)
          throw new Error('Invalid NLI scores')
        if (result.scores[result.label] < Math.max(...scores) - 1e-9)
          throw new Error('NLI label differs from scores')
      }
      const next = { ...task, status: 'completed' as const, result }
      const prior = tasks.get(key)
      tasks.set(key, next)
      try { persist() } catch (error) { tasks.set(key, prior!); throw error }
    },
    sync(claims, predicates, scope, sourceText, relations = []) {
      const active = claims.filter(claim => claim.review.status === 'accepted'
        && claim.transactionTime.closedAt === null && allowed(claim, scope))
      const byRef = new Map(active.map(claim => [refKey(claim.ref), claim]))
      let invalidated = false
      for (const [key, task] of tasks) {
        const live = task.modelId === options.modelId && task.modelRevision === options.modelRevision
          && task.preprocessingVersion === preprocessingVersion
          && task.claims.every(ref => byRef.has(refKey(ref)))
        const nextStatus = live ? (task.result ? 'completed' : 'pending') : 'stale'
        if (task.status !== nextStatus) {
          tasks.set(key, { ...task, status: nextStatus })
          invalidated = true
        }
      }
      if (invalidated) persist()
      // Indexes are rebuilt from the authoritative L1 snapshot, so a restart cannot silently lose candidates.
      const entity = new Map<string, Set<string>>()
      const subjectPredicate = new Map<string, Set<string>>()
      const episode = new Map<string, Set<string>>()
      const adjacency = new Map<string, Set<string>>()
      const vectors = new Map<string, number[]>()
      const spec = new Map(predicates.map(predicate => [predicate.name, predicate]))
      for (const claim of active) {
        const ref = refKey(claim.ref)
        for (const term of Object.values(claim.atom.args))
          if (term.kind === 'entity') addIndex(entity, term.ref.id, ref)
        const predicate = spec.get(claim.atom.predicate)
        if (predicate) for (const role of predicate.keyRoles) {
          const term = claim.atom.args[role]
          if (term) addIndex(subjectPredicate, `${predicate.name}\0${role}\0${JSON.stringify(term)}`, ref)
        }
        for (const source of claim.provenance.sources) addIndex(episode, source.episodeId, ref)
        vectors.set(ref, createLocalHashEmbedding(sourceText(claim)))
      }
      for (const relation of relations) {
        if (relation.review.status !== 'accepted' || relation.transactionTime.closedAt !== null) continue
        const from = refKey(relation.from), to = refKey(relation.to)
        if (byRef.has(from) && byRef.has(to)) {
          addIndex(adjacency, from, to)
          addIndex(adjacency, to, from)
        }
      }
      let created = 0
      const prior = new Set<string>()
      // The newer Claim initiates each pair; exact-version checkpoints avoid rescanning old insertions.
      for (const source of active.sort((a, b) => a.transactionTime.recordedAt - b.transactionTime.recordedAt
        || refKey(a.ref).localeCompare(refKey(b.ref)))) {
        const sourceRef = refKey(source.ref)
        const checkpoint = graphRelationPairKey(source.ref, source.ref, options.modelId,
          options.modelRevision, preprocessingVersion)
        if (processed.has(checkpoint)) { prior.add(sourceRef); continue }
        const eligibleRefs = source.ref.version > 1
          ? new Set(active.map(item => refKey(item.ref)).filter(ref => ref !== sourceRef)) : prior
        const sourceCue = gather(episode, source.provenance.sources.map(item => item.episodeId), byRef)
          .filter(item => eligibleRefs.has(refKey(item.ref)))
        const entityKeys = Object.values(source.atom.args).filter(term => term.kind === 'entity')
          .map(term => term.ref.id)
        const predicate = spec.get(source.atom.predicate)
        const subjectKeys = predicate?.keyRoles.flatMap(role => {
          const term = source.atom.args[role]
          return term ? [`${predicate.name}\0${role}\0${JSON.stringify(term)}`] : []
        }) ?? []
        const structured = unique([...gather(entity, entityKeys, byRef),
          ...gather(subjectPredicate, subjectKeys, byRef)])
          .filter(item => eligibleRefs.has(refKey(item.ref)))
        const vector = vectors.get(sourceRef)!
        const dense = [...active].filter(item => eligibleRefs.has(refKey(item.ref)))
          .map(item => ({ item, score: cosine(vector, vectors.get(refKey(item.ref))!) }))
          .filter(item => item.score >= 0.2)
          .sort((a, b) => b.score - a.score || refKey(a.item.ref).localeCompare(refKey(b.item.ref)))
          .map(item => item.item)
        const retrieved = unique([...sourceCue, ...structured, ...dense])
        const neighbors = retrieved.flatMap(seed => [...(adjacency.get(refKey(seed.ref)) ?? [])]
          .map(ref => byRef.get(ref)).filter((item): item is GraphClaimRecord => !!item && eligibleRefs.has(refKey(item.ref)))
          .map(related => ({ seed: seed.ref, related })))
        const selected = selectGraphRelationPairSeeds({ source, comparisonScope: scope,
          sourceCue, structured, dense, neighbors,
          maxCandidates: options.maxCandidates ?? 32, maxDenseSeeds: options.maxDenseSeeds ?? 8 })
        const before = new Map(tasks)
        for (const pair of selected) {
          const target = byRef.get(refKey(pair.to))!
          const sourceIsNewer = source.transactionTime.recordedAt > target.transactionTime.recordedAt
            || source.transactionTime.recordedAt === target.transactionTime.recordedAt
              && sourceRef.localeCompare(refKey(target.ref)) > 0
          const from = sourceIsNewer ? pair.from : pair.to
          const to = sourceIsNewer ? pair.to : pair.from
          const key = graphRelationPairKey(from, to, options.modelId,
            options.modelRevision, preprocessingVersion)
          const existing = tasks.get(key)
          if (existing) {
            if (!existing.routes.includes(pair.route)) tasks.set(key, { ...existing, routes: [...existing.routes, pair.route] })
            continue
          }
          tasks.set(key, { key, claims: [from, to], modelId: options.modelId,
            modelRevision: options.modelRevision, preprocessingVersion, routes: [pair.route],
            status: 'pending', createdAt: Date.now() })
          created++
        }
        processed.add(checkpoint)
        try { persist() }
        catch (error) {
          tasks.clear(); for (const [key, value] of before) tasks.set(key, value)
          processed.delete(checkpoint)
          throw error
        }
        prior.add(sourceRef)
      }
      return created
    },
  }
}

function allowed(claim: GraphClaimRecord, scope: GraphScope): boolean {
  return claim.scope.ownerId === scope.ownerId && claim.scope.agentId === scope.agentId
    && (scope.sessionId === undefined || claim.scope.sessionId === undefined || claim.scope.sessionId === scope.sessionId)
}
function refKey(ref: GraphClaimRef): string { return `${ref.kind}\0${ref.id}\0${ref.version}` }
function addIndex(index: Map<string, Set<string>>, key: string, ref: string): void {
  const refs = index.get(key) ?? new Set<string>()
  refs.add(ref); index.set(key, refs)
}
function gather(index: Map<string, Set<string>>, keys: readonly string[], claims: Map<string, GraphClaimRecord>): GraphClaimRecord[] {
  return unique(keys.flatMap(key => [...(index.get(key) ?? [])].map(ref => claims.get(ref))
    .filter((item): item is GraphClaimRecord => !!item)))
}
function unique(claims: readonly GraphClaimRecord[]): GraphClaimRecord[] {
  return [...new Map(claims.map(claim => [refKey(claim.ref), claim])).values()]
}
function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) return 0
  let dot = 0, aa = 0, bb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; aa += a[i]! ** 2; bb += b[i]! ** 2 }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0
}
