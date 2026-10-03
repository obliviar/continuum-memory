import type { Embedder } from '@continuum-memory/contracts'
import { createNativeL2Fixture } from './native-l2-regression'
import { createV4L2Memory } from '../adapters/v4-l2-memory'
import { createMemoryEmbeddingIndex } from '../../long-term/embedding-index'
import { prepareEntityVectors } from '../recall/entity-vector-preparation'

/** Fixed synthetic native Entity/Claim corpus; labels are shared by all retrieval modes. */
export async function compareEntityVectorModel(embedder: Embedder) {
  const f = await createNativeL2Fixture()
  const published = await f.publish(); if (!published.ok) throw new Error(published.error.message)
  const entityIndex = createMemoryEmbeddingIndex(), factIndex = createMemoryEmbeddingIndex()
  const preparationStart = performance.now()
  await prepareEntityVectors({ bundle: f.projection.snapshot()!.semanticBundle, index: entityIndex,
    model: embedder.model, embed: text => embedder.embed(text), isCurrent: () => true })
  for (const fact of f.repository.snapshot().facts) factIndex.putBatch([{ memoryId: fact.id,
    model: embedder.model, content: fact.canonicalText, vector: await embedder.embed(fact.canonicalText) }])
  const preparationMs = performance.now() - preparationStart
  const allFacts = f.repository.snapshot().facts.map(fact => fact.id).sort()
  const questions = [
    { query: 'Acme', expected: allFacts },
    { query: 'Alex works at Acme', expected: allFacts },
    { query: 'Where does Alexander work?', expected: allFacts },
    { query: 'Which company employs Alex?', expected: allFacts },
    { query: 'Alexander在哪里工作', expected: allFacts },
    { query: 'Acme相关的记忆', expected: allFacts, relation: true },
    { query: 'Bob works at Acme', expected: [] },
    { query: 'Acme养了什么宠物', expected: [] },
    { query: '我喜欢喝什么饮料', expected: [] },
  ]
  const pending = new Set<Promise<unknown>>()
  const embedQuery = (query: string) => {
    const promise = embedder.embed(query).then(vector => ({ model: embedder.model, vector }))
    pending.add(promise); void promise.then(() => pending.delete(promise), () => pending.delete(promise)); return promise
  }
  const modes = []
  try {
    for (const retrievalMode of ['lexical', 'hybrid', 'vector', 'entity-vector'] as const) {
      const port = createV4L2Memory({ ...f.options, retrievalMode, structuredRecall: false,
        semantic: { model: embedder.model, dimensions: embedder.dimensions, index: factIndex, embedQuery },
        entitySemantic: { model: embedder.model, dimensions: embedder.dimensions, index: entityIndex, embedQuery } })
      const cases = []
      for (const row of questions) {
        await Promise.allSettled([...pending])
        const started = performance.now(), r = await port.recall({ ...f.request, query: row.query, recallId: `${retrievalMode}:${row.query}` })
        const actual = r.ok ? r.value.evidence.claims.flatMap(c => c.kind === 'direct' ? [c.fact.id] : []).sort() : []
        const qualityPassed = r.ok && JSON.stringify(actual) === JSON.stringify(row.expected)
          && (!row.relation || r.value.evidence.relations?.length === 1)
        cases.push({ ...row, actual, qualityPassed, elapsedMs: performance.now() - started,
          error: r.ok ? null : r.error, searchScope: r.ok ? r.value.trace.searchScope : [],
          relationCount: r.ok ? r.value.evidence.relations?.length ?? 0 : 0 })
      }
      modes.push({ retrievalMode, tests: cases.length, passed: cases.filter(c => c.qualityPassed).length, cases })
    }
  } finally { await Promise.allSettled([...pending]) }
  return { schema: 'entity-vector-model-comparison/v1', model: embedder.model, dimensions: embedder.dimensions,
    preparationMs, corpus: 'synthetic-two-claims-not-human-reviewed', modes,
    limitation: 'Diagnostic only, not a release quality gate. Same questions, gold evidence and budgets; warm model; exact-flat indexes. No threshold tuning on these cases.' }
}
