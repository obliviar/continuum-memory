import { describe, expect, it, vi } from 'vitest'
import type { MemoryExtractor } from '@continuum-memory/memory'
import { createGraphExtractionResultStore, createGraphExtractionRun } from '@continuum-memory/memory'
import { createRulesWithGraphExtractor } from './graph-rules-extractor'

const turn = { userMessage: '张三在北京大学工作。' } as Parameters<MemoryExtractor>[0]

describe('rules memory with independent graph capture', () => {
  it('keeps the exact rules candidates while capturing a graph observation', async () => {
    const candidates: Awaited<ReturnType<MemoryExtractor>> = []
    const captureGraph = vi.fn(async () => {})
    const onGraphError = vi.fn()
    const extractor = createRulesWithGraphExtractor({ rules: async () => candidates,
      captureGraph, onGraphError })
    expect(await extractor(turn)).toBe(candidates)
    expect(captureGraph).toHaveBeenCalledWith(turn)
    expect(onGraphError).not.toHaveBeenCalled()
  })

  it('persists a graph extraction independently of rules candidates', async () => {
    let payload: string | undefined
    const store = createGraphExtractionResultStore({ load: () => payload,
      save: value => { payload = value } })
    const candidates: Awaited<ReturnType<MemoryExtractor>> = []
    const extractor = createRulesWithGraphExtractor({ rules: async () => candidates,
      captureGraph: async input => { store.append(createGraphExtractionRun({
        sourceId: 'message-1', sourceText: input.userMessage,
        modelId: 'uie-base', rawOutput: {},
      })) }, onGraphError: () => {} })
    expect(await extractor(turn)).toBe(candidates)
    expect(store.list()).toHaveLength(1)
    expect(payload).toContain('message-1')
  })

  it('keeps rules usable if UIE graph capture fails', async () => {
    const candidates: Awaited<ReturnType<MemoryExtractor>> = []
    const failure = new Error('Local model unavailable')
    const onGraphError = vi.fn()
    const extractor = createRulesWithGraphExtractor({ rules: async () => candidates,
      captureGraph: async () => { throw failure }, onGraphError })
    expect(await extractor(turn)).toBe(candidates)
    expect(onGraphError).toHaveBeenCalledWith(failure)
  })
})
