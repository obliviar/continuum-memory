import '../../memory/src/graph-core/eval/register-typescript.mjs'
import assert from 'node:assert/strict'
import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
const { createOnnxReranker } = await import('../src/onnx-reranker.ts')
const { values } = parseArgs({ options: { directory: { type: 'string' } } })
if (!values.directory) throw new Error('Pass --directory; checks are offline and read-only')
const directory = resolve(values.directory), model = createOnnxReranker({ directory }), checks = []
const signal = () => new AbortController().signal
try {
  await assert.rejects(model.score('问题', [{ id: 'a', text: '事实' }], signal()), /Preload/); checks.push('requires-preload')
  await model.load(); checks.push('pinned-files-and-local-runtime-load')
  await assert.rejects(model.score('问题', [{ id: 'a', text: '长'.repeat(1000) }], signal()), /token limit/); checks.push('no-silent-token-truncation')
  await assert.rejects(model.score('问题', [{ id: 'a', text: '事实' }, { id: 'a', text: '重复' }], signal()), /Invalid reranker input/); checks.push('duplicate-id-rejected')
  const aborted = new AbortController(); aborted.abort()
  await assert.rejects(model.score('问题', [{ id: 'a', text: '事实' }], aborted.signal)); checks.push('abort-before-inference')
  const scores = await model.score('我干哪一行', [{ id: 'job', text: '用户的职业是软件工程师' }, { id: 'drink', text: '用户喜欢喝乌龙茶' }], signal())
  assert.equal(scores.length, 2); assert(scores.every(s => Number.isFinite(s.score))); checks.push('real-pair-logits-after-rejections')
  console.log(JSON.stringify({ model: model.id, checks, scores }, null, 2))
} finally { await model.dispose() }
