import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createOnnxReranker } from '@continuum-memory/embedding-onnx'
import { createCrossEncoderSelection, type CandidateSelectionOptions } from '@continuum-memory/memory'

/** One offline model shared by conversations. No downloads or persistent evidence cache. */
export function createLocalGraphEvidenceSelection(directories: readonly string[], onUnavailable: () => void) {
  let model: ReturnType<typeof createOnnxReranker> | undefined
  let loading: Promise<void> | undefined
  let attempted = false, ready = false, closed = false
  async function prepare() {
    if (closed || ready) return
    if (loading) return loading
    if (attempted) return
    attempted = true
    const directory = directories.find(path => existsSync(join(path, 'onnx', 'model_quantized.onnx')))
    if (!directory) { onUnavailable(); return }
    const candidate = createOnnxReranker({ directory })
    model = candidate
    loading = candidate.load().then(() => { if (!closed) ready = true })
      .catch(async () => { onUnavailable(); await candidate.dispose(); if (model === candidate) model = undefined })
      .finally(() => { loading = undefined })
    return loading
  }
  function selection(): CandidateSelectionOptions {
    // Scope/query/IDs/texts bind the small score cache. Each graph port owns its pair adapter.
    const pair = createCrossEncoderSelection({ id: 'desktop-local-bge-pair-v1', score: async (...args) => {
      if (!ready || !model || closed) throw new Error('Local relevance model unavailable')
      return model.score(...args)
    } }, { minLogit: 0, maxLogitGap: 4 })
    return {
      get candidateLimit() { return ready ? 16 : 64 },
      timeoutMs: 500,
      get reranker() { return ready ? pair.reranker : undefined },
      get evidenceSelector() { return ready ? pair.evidenceSelector : undefined },
    }
  }
  return { prepare, selection, async dispose() {
    closed = true; ready = false
    await loading; await model?.dispose(); model = undefined
  } }
}
