import './register-typescript.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
const { values } = parseArgs({ options: { 'model-dir': { type: 'string' }, report: { type: 'string' } } })
if (!values['model-dir']) throw new Error('Pass --model-dir for an already installed local model; downloads are not performed')
const { createOnnxEmbedder } = await import('../../../../embedding-onnx/src/index.ts')
const { compareEntityVectorModel } = await import('./entity-vector-model-comparison.ts')
const embedder = createOnnxEmbedder({ cacheDir: resolve(values['model-dir']) })
try {
  if (!await embedder.verify()) throw new Error('Local model verification failed')
  const report = await compareEntityVectorModel(embedder)
  console.log(JSON.stringify(report, null, 2))
  if (values.report) {
    const path = resolve(values.report); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(report, null, 2), 'utf8')
  }
} finally { await embedder.dispose() }
