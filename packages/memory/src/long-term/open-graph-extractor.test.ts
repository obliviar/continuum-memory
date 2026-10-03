import { describe, expect, it } from 'vitest'
import { createOpenGraphExtractor } from './smart-memory-extractor'
import type { GraphExtractionRun } from './graph-extraction-result'
import { createGraphExtractionResultStore } from './graph-extraction-result'
import { createCaptureRepository } from './capture-repository'
import { projectOpenAssertions } from '../graph-core/repository/open-assertions'
import { recallOpenSources } from '../graph-core/recall/open-source-recall'

const source = '晶体A外延生长于衬底B'
function payload() {
  return { graph: { entities: [
    { id: 'a', type: 'crystal', text: '晶体A', span: { start: 0, end: 3 }, modelScore: 0.3 },
    { id: 'b', type: 'substrate', text: '衬底B', span: { start: 8, end: 11 }, modelScore: 0.4 },
  ], facts: [], assertions: [{ id: 'r', relationText: '外延生长于', relationSpan: { start: 3, end: 8 },
    participants: [{ mentionId: 'a', role: 'subject' }, { mentionId: 'b', role: 'substrate' }],
    evidenceSpan: { start: 0, end: 11 }, modelScore: 0.2 }] } }
}

describe('independent open graph extraction', () => {
  it('makes unknown source-grounded relations navigable without canonical claims or manual reviews', async () => {
    function disk() { let value: string | undefined; return { load: () => value, save: (next: string) => { value = next } } }
    const captures = createCaptureRepository({ persistence: disk() })
    const extractions = createGraphExtractionResultStore(disk())
    const scope = { ownerId: 'owner', agentId: 'agent' }
    const turn = { userMessage: source, assistantMessage: '', metadata: { sourceMessageIds: ['m1'] } }
    captures.register(turn, scope, 'open-test')
    await createOpenGraphExtractor({ getConfig: () => ({ apiKey: 'fixture', model: 'fixture' }),
      complete: async () => JSON.stringify(payload()), saveGraphExtraction: run => extractions.append(run),
    })(turn)
    const records = projectOpenAssertions(captures.snapshot(), extractions, scope)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ relationText: '外延生长于', admission: { localNavigation: 'automatic' },
      inferenceAllowed: false })
    expect(extractions.openReviews()).toEqual([])
    const hits = recallOpenSources({ captures: captures.snapshot(), extractions, scope, query: '晶体A', canRead: () => true })
    expect(hits.map(hit => hit.content)).toEqual([source])
  })
  it('extracts an arbitrary low-score relation without UIE, a predicate registry or memory conversion', async () => {
    const saved: GraphExtractionRun[] = []
    const extractor = createOpenGraphExtractor({
      getConfig: () => ({ apiKey: 'fixture', model: 'open-fixture' }),
      complete: async prompt => {
        expect(prompt).toContain('不提供领域 schema')
        expect(prompt).not.toContain('assistant-only fiction')
        // Malformed durable-memory payload does not poison the independent graph channel.
        return JSON.stringify({ ...payload(), memories: Array.from({ length: 129 }, () => ({})) })
      },
      fallback: () => [{ content: 'local preference', metadata: {} }],
      saveGraphExtraction: run => { saved.push(run) },
    })
    expect(await extractor({ userMessage: source, assistantMessage: 'assistant-only fiction',
      metadata: { sourceMessageIds: ['source-1'] } })).toHaveLength(1)
    expect(saved[0]).toMatchObject({ sourceId: 'source-1', sourceText: source,
      assertionCandidates: [{ relationText: '外延生长于', modelScore: 0.2 }] })
    expect(saved[0]?.status).toBe('complete')
  })

  it.each(['missing', 'invented'] as const)('rejects %s relation grounding without asking for predicate approval', async invalid => {
    const raw = payload()
    if (invalid === 'missing') delete (raw.graph.assertions[0] as { relationSpan?: unknown }).relationSpan
    else raw.graph.assertions[0]!.relationText = '属于'
    const saved: GraphExtractionRun[] = []
    await createOpenGraphExtractor({ getConfig: () => ({ apiKey: 'fixture', model: 'fixture' }),
      complete: async () => JSON.stringify(raw), saveGraphExtraction: run => { saved.push(run) },
    })({ userMessage: source, assistantMessage: '' })
    expect(saved[0]).toMatchObject({ status: 'incomplete', assertionCandidates: [] })
    expect(saved[0]?.rawOutput).toEqual(raw)
  })

  it('checks source permission before sending text and preserves local candidates', async () => {
    let calls = 0
    const result = await createOpenGraphExtractor({
      getConfig: () => ({ apiKey: 'fixture', model: 'fixture' }), canSendSource: () => false,
      complete: async () => { calls++; return JSON.stringify(payload()) },
      fallback: () => [{ content: 'local', metadata: {} }],
    })({ userMessage: source, assistantMessage: '' })
    expect(calls).toBe(0)
    expect(result).toHaveLength(1)
  })

  it('keeps rule fallback and diagnostics on provider failure', async () => {
    const saved: GraphExtractionRun[] = []
    const result = await createOpenGraphExtractor({
      getConfig: () => ({ apiKey: 'fixture', model: 'fixture' }),
      complete: async () => { throw new Error('offline') },
      fallback: () => [{ content: 'local', metadata: {} }],
      saveGraphExtraction: run => { saved.push(run) },
    })({ userMessage: source, assistantMessage: '' })
    expect(result).toHaveLength(1)
    expect(saved[0]?.status).toBe('failed')
  })
})
