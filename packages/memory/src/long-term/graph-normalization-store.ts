import type { GraphAliasDecision, GraphEntityRecord, GraphNormalizationResult } from './graph-identity-normalization'

export interface GraphNormalizationPersistence {
  load: () => string | undefined
  save: (payload: string) => void
}

export interface GraphNormalizationStore {
  entities: () => GraphEntityRecord[]
  aliasDecisions: () => GraphAliasDecision[]
  results: () => GraphNormalizationResult[]
  /** Trusted graph-core publisher supplies reviewed catalog records. */
  replaceCatalog: (entities: readonly GraphEntityRecord[], decisions: readonly GraphAliasDecision[]) => void
  appendResult: (result: GraphNormalizationResult) => void
  removeSources: (sourceIds: readonly string[]) => void
  clear: () => void
}

/** Identity decisions and normalized candidates live apart from raw UIE mentions. */
export function createGraphNormalizationStore(persistence: GraphNormalizationPersistence): GraphNormalizationStore {
  const raw = persistence.load()
  const state = raw ? JSON.parse(raw) as {
    version?: unknown
    entities?: unknown
    aliasDecisions?: unknown
    results?: unknown
  } : undefined
  if (state && (state.version !== 1 || !Array.isArray(state.entities)
    || !Array.isArray(state.aliasDecisions) || !Array.isArray(state.results)))
    throw new Error('Invalid graph normalization store')
  let entities = (state?.entities ?? []) as GraphEntityRecord[]
  let aliasDecisions = (state?.aliasDecisions ?? []) as GraphAliasDecision[]
  let results = (state?.results ?? []) as GraphNormalizationResult[]
  const save = (nextEntities: GraphEntityRecord[], nextDecisions: GraphAliasDecision[], nextResults: GraphNormalizationResult[]): void => {
    persistence.save(JSON.stringify({ version: 1, entities: nextEntities, aliasDecisions: nextDecisions, results: nextResults }))
    entities = nextEntities
    aliasDecisions = nextDecisions
    results = nextResults
  }
  return {
    entities: () => [...entities],
    aliasDecisions: () => [...aliasDecisions],
    results: () => [...results],
    replaceCatalog(nextEntities, nextDecisions) { save([...nextEntities], [...nextDecisions], results) },
    appendResult(result) { save(entities, aliasDecisions, [...results.filter(item => item.runId !== result.runId), result]) },
    removeSources(sourceIds) {
      const removed = new Set(sourceIds)
      save(entities, aliasDecisions, results.filter(result => !removed.has(result.sourceId)))
    },
    clear() { save([], [], []) },
  }
}
