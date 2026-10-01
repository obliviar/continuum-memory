import { createDenseVectorCandidateIndex } from '../../long-term/dense-vector-candidate-index'
import { createDirectLexicalIndex } from '../recall/direct-lexical'

/** Controlled index-only microbenchmark. Repeated content is not a recall-quality corpus. */
export function measureRetrievalIndexScaling(documents: readonly { text: string; vector: number[] }[], query: string, vector: number[]) {
  if (!documents.length) throw new Error('Scaling probe requires prepared documents')
  const scope = { ownerId: 'synthetic', agentId: 'probe' }, rows = []
  for (const size of [100, 1000, 10000]) {
    const lexical = createDirectLexicalIndex(query), dense = createDenseVectorCandidateIndex()
    let started = performance.now()
    for (let i = 0; i < size; i++) lexical.upsert({ id: String(i), content: documents[i % documents.length]!.text, scope, state: 'active' })
    const lexicalBuildMs = performance.now() - started
    started = performance.now()
    for (let i = 0; i < size; i++) dense.upsert(String(i), documents[i % documents.length]!.vector)
    const vectorBuildMs = performance.now() - started
    const lexicalSamplesMs: number[] = [], vectorSamplesMs: number[] = []
    lexical.search(query, { scope, limit: 64 }); dense.search(vector, { limit: 64 })
    for (let n = 0; n < 5; n++) {
      started = performance.now(); lexical.search(query, { scope, limit: 64 }); lexicalSamplesMs.push(performance.now() - started)
      started = performance.now(); dense.search(vector, { limit: 64 }); vectorSamplesMs.push(performance.now() - started)
    }
    rows.push({ size, lexicalBuildMs, vectorBuildMs, lexicalSamplesMs, vectorSamplesMs, exactVectorsScored: size })
  }
  return { candidateLimit: 64, rows, limitation: 'Repeated synthetic texts with real model vectors. Index-only build/search; excludes model inference, projection/source validation and graph traversal. Five samples are diagnostic, not a stable latency SLA. Dense search is exact O(N*d) scoring plus sorting, not ANN.' }
}
