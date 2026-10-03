import { describe, expect, it } from 'vitest'
import { createOpenGraphExtractor, createSmartMemoryExtractor, type GraphExtractionRun } from '@continuum-memory/memory'
import { isGraphExtractionEnabled, shouldPersistGraphExtraction } from './graph-extraction-policy'

describe('desktop open discovery and local supplement persistence', () => {
  it.each(['smart', 'open'] as const)('keeps %s API relationships when local graph supplements are disabled', async (mode) => {
    const settings = { extractionMode: mode, graphExtractionEnabled: false }
    const saved: GraphExtractionRun[] = []
    const factory = mode === 'smart' ? createSmartMemoryExtractor : createOpenGraphExtractor
    const extractor = factory({ getConfig: () => ({ apiKey: 'synthetic', model: 'test' }),
      complete: async () => JSON.stringify({ memories: [], graph: {
        entities: [
          { id: 'a', type: 'item', text: '样品', span: { start: 0, end: 2 }, modelScore: 0.9 },
          { id: 'b', type: 'place', text: '箱内', span: { start: 5, end: 7 }, modelScore: 0.9 },
        ], facts: [], assertions: [{ id: 'r', relationText: '存放于', relationSpan: { start: 2, end: 5 },
          participants: [{ mentionId: 'a', role: 'subject' }, { mentionId: 'b', role: 'object' }],
          evidenceSpan: { start: 0, end: 7 }, modelScore: 0.9, context: {} }],
      } }),
      saveGraphExtraction: run => { if (shouldPersistGraphExtraction(settings, 'remote')) saved.push(run) },
    })
    await extractor({ userMessage: '样品存放于箱内', assistantMessage: '', metadata: { sourceMessageIds: ['source'] } })
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ status: 'complete', sourceId: 'source', remoteExtraction: true })
    expect(saved[0]?.assertionCandidates?.[0]?.relationText).toBe('存放于')
    expect(isGraphExtractionEnabled(settings)).toBe(true)
    expect(shouldPersistGraphExtraction(settings, 'local')).toBe(false)
  })

  it('keeps forced UIE persistence and respects the optional switch in rules mode', () => {
    expect(shouldPersistGraphExtraction({ extractionMode: 'uie', graphExtractionEnabled: false }, 'local')).toBe(true)
    const rules = { extractionMode: 'rules' as const, graphExtractionEnabled: false }
    expect(isGraphExtractionEnabled(rules)).toBe(false)
    expect(shouldPersistGraphExtraction(rules, 'remote')).toBe(false)
    expect(shouldPersistGraphExtraction({ ...rules, graphExtractionEnabled: true }, 'local')).toBe(true)
  })
})
