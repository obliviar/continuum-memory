import { describe, expect, it } from 'vitest'
import {
  createGraphExtractionResultStore,
  createGraphExtractionRun,
  selectGraphWriteCandidates,
} from './graph-extraction-result'

describe('graph extraction result protocol', () => {
  it('persists all UIE facts before score and count policy', () => {
    const sourceText = 'Alice likes tea'
    const facts = Array.from({ length: 10 }, (_, index) => ({
      id: `fact-${index}`,
      subjectMentionId: 'alice',
      predicate: 'likes',
      object: { mentionId: 'tea' },
      evidenceSpan: { start: 0, end: sourceText.length },
      modelScore: index === 0 ? 0.5 : 0.9,
      context: {
        negation: { value: false, resolution: 'resolved', evidenceSpan: { start: 6, end: 11 } },
        condition: { value: null, resolution: 'absent' },
        time: { value: null, resolution: 'unresolved' },
        speaker: { value: 'Alice', resolution: 'resolved', evidenceSpan: { start: 0, end: 5 } },
      },
    }))
    const rawOutput = { graph: { entities: [
      { id: 'alice', type: 'person', text: 'Alice', span: { start: 0, end: 5 }, modelScore: 0.99 },
      { id: 'tea', type: 'thing', text: 'tea', span: { start: 12, end: 15 }, modelScore: 0.8 },
    ], facts } }
    const run = createGraphExtractionRun({ sourceId: 'message-1', sourceText, modelId: 'uie-test', rawOutput })
    let payload: string | undefined
    const store = createGraphExtractionResultStore({ load: () => payload, save: value => { payload = value } })
    store.append(run)

    expect(run.status).toBe('complete')
    expect(store.list()[0]?.rawOutput).toEqual(rawOutput)
    expect(store.list()[0]?.factCandidates).toHaveLength(10)
    expect(selectGraphWriteCandidates(run)).toMatchObject({ selected: expect.arrayContaining([expect.objectContaining({ id: 'fact-1' })]), belowThreshold: 1, deferred: 1, status: 'incomplete', statusReason: 'graph-write-budget-exhausted' })
    expect(selectGraphWriteCandidates(run).selected).toHaveLength(8)
  })

  it('marks partial extraction incomplete while retaining the raw response', () => {
    const rawOutput = { graph: { entities: [], facts: [{ id: 'bad' }] } }
    const run = createGraphExtractionRun({ sourceId: 'message-2', sourceText: 'test', modelId: 'uie-test', rawOutput })
    expect(run.status).toBe('incomplete')
    expect(run.statusReason).toBe('invalid-items:1')
    expect(run.rawOutput).toEqual(rawOutput)
  })

  it('records unprocessed items when the parser safety budget is reached', () => {
    const rawOutput = { graph: { entities: Array.from({ length: 1_001 }, () => null), facts: [] } }
    const run = createGraphExtractionRun({ sourceId: 'message-3', sourceText: 'test', modelId: 'uie-test', rawOutput })
    expect(run).toMatchObject({ status: 'incomplete', statusReason: 'uie-parse-budget-exhausted', unprocessedEntityCount: 1 })
    expect((run.rawOutput as typeof rawOutput).graph.entities).toHaveLength(1_001)
  })
})
