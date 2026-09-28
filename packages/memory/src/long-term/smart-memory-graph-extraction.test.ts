import { describe, expect, it } from 'vitest'
import { createSmartMemoryExtractor } from './smart-memory-extractor'
import type { GraphExtractionRun } from './graph-extraction-result'

describe('smart extractor graph capture', () => {
  it('saves the complete model structure before memory conversion', async () => {
    const saved: GraphExtractionRun[] = []
    const raw = { memories: [], graph: { entities: [
      { id: 'e1', type: 'person', text: 'Alice', span: { start: 0, end: 5 }, modelScore: 0.4 },
    ], facts: [] } }
    const extractor = createSmartMemoryExtractor({
      getConfig: () => ({ apiKey: 'test', model: 'uie-test' }),
      complete: async () => JSON.stringify(raw),
      saveGraphExtraction: run => { saved.push(run) },
    })
    await extractor({ userMessage: 'Alice', assistantMessage: '', metadata: { sourceMessageIds: ['m1'] } })
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ sourceId: 'm1', modelId: 'uie-test', status: 'complete' })
    expect(saved[0]?.rawOutput).toEqual(raw)
    expect(saved[0]?.entityMentions[0]?.modelScore).toBe(0.4)
  })

  it('records failed model output and falls back to local extraction', async () => {
    const saved: GraphExtractionRun[] = []
    const extractor = createSmartMemoryExtractor({
      getConfig: () => ({ apiKey: 'test', model: 'uie-test' }),
      complete: async () => '{broken',
      fallback: () => [{ content: 'local fact', metadata: { kind: 'explicit' } }],
      saveGraphExtraction: run => { saved.push(run) },
    })
    expect(await extractor({ userMessage: 'Alice', assistantMessage: '' })).toHaveLength(1)
    expect(saved).toMatchObject([{ status: 'failed', statusReason: 'model-or-response-error', rawOutput: '{broken' }])
  })
})
