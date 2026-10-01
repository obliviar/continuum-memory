import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { LocalCrossEncoder } from '@continuum-memory/memory'
import { RERANKER_MODEL, RERANKER_REVISION, RERANKER_FILES } from './reranker-manifest'

/** Offline-only model. Installation is an explicit separate command. */
export function createOnnxReranker(options: { directory: string; batchSize?: number }) {
  const directory = resolve(options.directory), batchSize = options.batchSize ?? 4
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 16) throw new Error('Invalid reranker batch size')
  let runtime: { tokenizer: any; model: any } | undefined
  let loading: Promise<void> | undefined, active: Promise<unknown> | undefined
  let closed = false
  const id = `${RERANKER_MODEL}@${RERANKER_REVISION}:q8:pair512-v1`
  async function load() {
    if (closed) throw new Error('Reranker disposed')
    if (runtime) return
    if (loading) return loading
    loading = (async () => {
      for (const file of RERANKER_FILES) {
        const path = resolve(directory, file.path)
        if ((await stat(path)).size !== file.bytes) throw new Error(`Reranker file size mismatch: ${file.path}`)
        const hash = createHash('sha256' in file ? 'sha256' : 'sha1')
        if ('gitBlob' in file) hash.update(`blob ${file.bytes}\0`)
        for await (const chunk of createReadStream(path)) hash.update(chunk)
        if (hash.digest('hex') !== ('sha256' in file ? file.sha256 : file.gitBlob)) throw new Error(`Reranker integrity mismatch: ${file.path}`)
      }
      const { AutoTokenizer, AutoModelForSequenceClassification } = await import('@huggingface/transformers')
      const tokenizer = await AutoTokenizer.from_pretrained(directory, { local_files_only: true })
      const model = await AutoModelForSequenceClassification.from_pretrained(directory, { local_files_only: true, dtype: 'q8',
        session_options: { intraOpNumThreads: 2, interOpNumThreads: 1, executionMode: 'sequential' } })
      runtime = { tokenizer, model }
    })().finally(() => { loading = undefined })
    return loading
  }
  const score: LocalCrossEncoder['score'] = async (query, candidates, signal) => {
    signal.throwIfAborted()
    if (closed || !runtime) throw new Error('Preload the local reranker before starting the recall budget')
    if (active) throw new Error('Local reranker busy; no unbounded inference queue')
    if (!query.trim() || query.length > 2000 || candidates.length > 256 || new Set(candidates.map(c => c.id)).size !== candidates.length
      || candidates.some(c => !c.id || !c.text.trim() || c.text.length > 16000)) throw new Error('Invalid reranker input')
    const { tokenizer, model } = runtime
    const run = async () => {
      // Do not silently score a truncated prefix as if the whole fact were checked.
      for (const c of candidates) {
        signal.throwIfAborted()
        if (tokenizer.encode(query, { text_pair: c.text }).length > 512) throw new Error('Reranker pair exceeds token limit')
      }
      const result: { id: string; score: number }[] = []
      for (let start = 0; start < candidates.length; start += batchSize) {
        signal.throwIfAborted()
        const batch = candidates.slice(start, start + batchSize)
        const inputs = tokenizer(batch.map(() => query), { text_pair: batch.map(c => c.text), padding: true, truncation: false })
        let outputs: any
        try {
          outputs = await model(inputs)
          signal.throwIfAborted()
          const tensor = outputs.logits
          if (tensor?.dims?.length !== 2 || tensor.dims[0] !== batch.length || tensor.dims[1] !== 1 || tensor.data.length !== batch.length)
            throw new Error('Unexpected reranker output shape')
          batch.forEach((c, i) => {
            const value = Number(tensor.data[i]); if (!Number.isFinite(value)) throw new Error('Invalid reranker logit')
            result.push({ id: c.id, score: value })
          })
        } finally {
          for (const tensor of Object.values(outputs ?? {}) as any[]) tensor?.dispose?.()
          for (const tensor of Object.values(inputs) as any[]) tensor?.dispose?.()
        }
      }
      return result
    }
    const running = run(); active = running
    try { return await running } finally { if (active === running) active = undefined }
  }
  return { id, load, score,
    async drain() { await active?.catch(() => undefined) },
    async dispose() {
      closed = true; await loading?.catch(() => undefined); await active?.catch(() => undefined)
      await runtime?.model.dispose(); runtime = undefined
    } }
}
