import assert from 'node:assert/strict'
import { createCrossEncoderSelection } from '../recall/cross-encoder-selection'
import { selectRecallCandidates } from '../recall/candidate-selection'

/** Mock pair scores verify adapter contracts only; real-model quality has its own report. */
export async function runCrossEncoderRegression() {
  const checks: { id: string; passed: boolean; error?: string }[] = []
  const test = async (id: string, run: () => unknown | Promise<unknown>) => {
    try { await run(); checks.push({ id, passed: true }) } catch (e) { checks.push({ id, passed: false, error: String(e) }) }
  }
  const candidates = [{ id: 'no-milk', text: '用户不喝牛奶', score: 0.65 }, { id: 'city', text: '用户住在杭州', score: 0.85 }]
  const input = { query: '用户喝牛奶吗', candidates, signal: new AbortController().signal }
  await test('ranking-and-selection-share-one-model-call', async () => {
    let calls = 0
    const pair = createCrossEncoderSelection({ id: 'mock-pair', score: async () => { calls++; return [{ id: 'no-milk', score: 2 }, { id: 'city', score: -3 }] } }, { minLogit: 0 })
    const r = await selectRecallCandidates({ query: input.query, hits: candidates, text: id => candidates.find(c => c.id === id)!.text,
      finalLimit: 2, remainingMs: 1000, admissibleIds: new Set(['city']), options: pair })
    assert.equal(calls, 1); assert.deepEqual(r.selected.map(c => c.id), ['no-milk'])
  })
  await test('cache-keys-include-query-id-and-exact-text', async () => {
    let calls = 0
    const pair = createCrossEncoderSelection({ id: 'mock', score: async (_q, c) => { calls++; return c.map(i => ({ id: i.id, score: 1 })) } }, { minLogit: 0 })
    await pair.reranker.rank(input); await pair.evidenceSelector.select(input); assert.equal(calls, 1)
    await pair.reranker.rank({ ...input, query: '新问题' }); assert.equal(calls, 2)
    await pair.reranker.rank({ ...input, candidates: candidates.map(c => ({ ...c, text: c.text + '更新' })) }); assert.equal(calls, 3)
    await pair.reranker.rank({ ...input, candidates: candidates.map(c => ({ ...c, id: c.id + '-v2' })) }); assert.equal(calls, 4)
    pair.clear(); await pair.reranker.rank(input); assert.equal(calls, 5)
  })
  await test('rank-only-cannot-override-original-output-gate', async () => {
    const pair = createCrossEncoderSelection({ id: 'mock', score: async () => [{ id: 'no-milk', score: 10 }, { id: 'city', score: -5 }] }, { minLogit: 0 })
    const r = await selectRecallCandidates({ query: input.query, hits: candidates, text: id => id, finalLimit: 2,
      remainingMs: 1000, admissibleIds: new Set(['city']), options: { reranker: pair.reranker } })
    assert.deepEqual(r.selected.map(c => c.id), ['city'])
  })
  await test('no-positive-logits-means-insufficient-not-top-one', async () => {
    const pair = createCrossEncoderSelection({ id: 'mock', score: async () => candidates.map(c => ({ id: c.id, score: -1 })) }, { minLogit: 0 })
    assert.deepEqual(await pair.evidenceSelector.select(input), { status: 'insufficient', ids: [] })
  })
  for (const [id, output] of [
    ['foreign', [{ id: 'no-milk', score: 1 }, { id: 'foreign', score: 1 }]],
    ['duplicate', [{ id: 'city', score: 1 }, { id: 'city', score: 1 }]],
    ['nan', [{ id: 'no-milk', score: NaN }, { id: 'city', score: 1 }]],
  ] as const) await test(`invalid-pair-${id}-cannot-be-used`, async () => {
    const pair = createCrossEncoderSelection({ id: 'mock', score: async () => output }, { minLogit: 0 })
    await assert.rejects(pair.evidenceSelector.select(input), /Invalid cross-encoder/)
  })
  await test('aborted-score-cannot-populate-reuse-cache', async () => {
    let calls = 0
    const controller = new AbortController()
    const pair = createCrossEncoderSelection({ id: 'mock', score: async () => {
      calls++; if (calls === 1) controller.abort(); return candidates.map(c => ({ id: c.id, score: 1 }))
    } }, { minLogit: 0 })
    await assert.rejects(pair.reranker.rank({ ...input, signal: controller.signal }))
    await pair.reranker.rank(input); assert.equal(calls, 2)
  })
  await test('non-finite-experimental-cutoff-is-rejected', () => {
    assert.throws(() => createCrossEncoderSelection({ id: 'mock', score: async () => [] }, { minLogit: Infinity }))
  })
  return { checks }
}
