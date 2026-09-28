import './register-typescript.mjs'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: {
  'model-dir': { type: 'string' }, report: { type: 'string' }, help: { type: 'boolean' },
} })
if (values.help) {
  console.log('Usage: node packages/memory/src/graph-core/eval/run-direct-model.mjs --model-dir <installed-model-cache> --report <output.json>\nLocal verified ONNX model only; no downloads and no user memory reads. Exit: 0 quality gate passed, 1 failed/degraded, 2 model unavailable.')
} else {
  const configuredDir = values['model-dir'] || process.env.GRAPH_RECALL_MODEL_DIR
  const modelDir = configuredDir ? resolve(configuredDir)
    : process.env.APPDATA ? join(process.env.APPDATA, 'Continuum Memory', 'models', 'memory') : undefined
  const reportPath = values.report || process.env.GRAPH_RECALL_REPORT_PATH
  const initial = { schema: 'direct-model-comparison/v1', status: 'not-run', modelDir: modelDir ?? null,
    corpus: 'synthetic-not-human-reviewed', qualityGatePassed: null, baseline: null, trials: [] }
  let report = initial
  let embedder
  try {
    if (!modelDir || !existsSync(join(modelDir, 'bge-small-zh-v1.5.manifest.json'))) {
      report = { ...initial, reason: 'model-not-installed', message: 'Install the local semantic model in the desktop app, then pass its models/memory directory. No evaluation was run.' }
      process.exitCode = 2
    } else {
      const { createOnnxEmbedder } = await import('../../../../embedding-onnx/src/index.ts')
      const { compareDirectRecallModel } = await import('./direct-model-comparison.ts')
      embedder = createOnnxEmbedder({ cacheDir: modelDir })
      const start = performance.now()
      console.error('Verifying and warming the installed local model...')
      if (!await embedder.verify()) {
        report = { ...initial, reason: 'model-verification-failed', integrity: embedder.integrity() }
        process.exitCode = 2
      } else {
        const initializationMs = performance.now() - start
        report = { ...await compareDirectRecallModel(embedder, { onProgress: message => console.error(message) }),
          modelDir, initializationMs, provider: 'verified-local-onnx' }
        process.exitCode = report.qualityGatePassed ? 0 : 1
      }
    }
  } catch (error) {
    report = { ...initial, status: 'failed', reason: 'evaluation-error', message: String(error) }
    process.exitCode = 1
  } finally { await embedder?.dispose() }
  console.log(JSON.stringify(report, null, 2))
  if (reportPath) {
    const path = resolve(reportPath)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(report, null, 2), 'utf8')
  }
}
