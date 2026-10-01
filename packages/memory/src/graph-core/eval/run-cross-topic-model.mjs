import './register-typescript.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
const { values } = parseArgs({ options: { 'model-dir': { type: 'string' }, report: { type: 'string' }, 'reranker-dir': { type: 'string' }, 'min-logit': { type: 'string' } } })
if (!values['model-dir'] || !values.report) throw new Error('Pass --model-dir and --report; local models only, no downloads')
const { createOnnxEmbedder, createOnnxReranker } = await import('../../../../embedding-onnx/src/index.ts')
const { compareCrossTopicModel } = await import('./cross-topic-comparison.ts')
const embedder = createOnnxEmbedder({ cacheDir: resolve(values['model-dir']) })
const pair = values['reranker-dir'] ? createOnnxReranker({ directory: resolve(values['reranker-dir']) }) : undefined
const minLogit = Number(values['min-logit'] ?? 0)
if (!Number.isFinite(minLogit)) throw new Error('Invalid --min-logit')
try {
  if (!await embedder.verify()) throw new Error('Local model verification failed')
  const loadStart = performance.now(); await pair?.load()
  const pairLoadMs = pair ? performance.now() - loadStart : null
  const report = { ...await compareCrossTopicModel(embedder, pair ? { model: pair, drain: pair.drain, minLogit } : undefined), pairLoadMs }, path = resolve(values.report)
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(report, null, 2), 'utf8')
  console.log(JSON.stringify({ path, routes: report.routes }, null, 2))
  if (report.cases.some(c => !c.boundaryPassed)) process.exitCode = 1
} finally { await pair?.dispose(); await embedder.dispose() }
