import { describe, expect, it } from 'vitest'
import { createGraphExtractionResultStore } from './graph-extraction-result'
import { createGraphNormalizationStore } from './graph-normalization-store'
import { createGraphL1Store, createGraphL1Writer, assessGraphClaim, deferGraphClaim, rejectGraphClaim } from './graph-l1-write'
import { createGraphPredicateRegistry, normalizeGraphExtraction } from './graph-identity-normalization'
import { parseUieOutput, uieGraphExtractionRun } from './local-uie'
import { reassessRetainedUieGraphFacts } from './graph-policy-reassessment'
import { createMemoryV4Repository } from '../v4/repository/memory-v4-repository'
import type { CaptureSnapshot } from './capture-repository'

const scope = { ownerId: 'owner', agentId: 'agent' }
function persistence() {
  let value: string | undefined
  return { load: () => value, save: (next: string) => { value = next } }
}
function fixture(text = '我喜欢喝牛奶巧克力。', score = 0.82) {
  const value = '牛奶巧克力'
  const start = Array.from(text.slice(0, text.indexOf(value))).length
  const extraction = parseUieOutput(text, { 喜好: [{ text: value, start,
    end: start + Array.from(value).length, probability: score }] })
  const current = uieGraphExtractionRun('message-1', text, extraction)
  const run = { ...current, factCandidates: current.factCandidates.map(fact => ({ ...fact,
    context: { negation: { value: null, resolution: 'unresolved' as const },
      condition: { value: null, resolution: 'unresolved' as const },
      time: { value: null, resolution: 'unresolved' as const },
      speaker: { value: null, resolution: 'unresolved' as const } } })) }
  const extractions = createGraphExtractionResultStore(persistence())
  extractions.append(run)
  const normalization = createGraphNormalizationStore(persistence())
  const baseline = normalizeGraphExtraction(run, { entities: [], scope })
  normalization.appendResult(baseline)
  const l1 = createGraphL1Store(persistence())
  const review = { ...assessGraphClaim(run, baseline.facts[0]!, { sensitivity: 'private', sharePolicy: 'local-only' }),
    status: 'pending' as const, reason: 'legacy-unresolved-subject' }
  l1.recordReview(review)
  const v4 = createMemoryV4Repository()
  const writer = createGraphL1Writer(v4, l1, createGraphPredicateRegistry(), scope)
  const source: CaptureSnapshot['sources'][number] = { id: 'capture-1', identity: 'identity-1',
    revision: 1, scope: { ...scope, sessionId: 'chat-1' }, messageIds: ['message-1'], contentHash: 'capture-hash', status: 'active',
    createdAt: 1, turn: { userMessage: text, assistantMessage: '' } }
  const captures: CaptureSnapshot = { version: 1, sources: [source], tasks: [] }
  const reassess = () => reassessRetainedUieGraphFacts({ extractions, normalization, l1, writer,
    captureSnapshot: () => captures, scope })
  return { run, extractions, normalization, l1, v4, review, source, reassess }
}

describe('bounded graph policy re-assessment', () => {
  it('keeps unreviewed UIE facts pending without modifying the raw extraction', async () => {
    const f = fixture()
    const original = JSON.stringify(f.extractions.list()[0])
    expect(await f.reassess()).toEqual({ reviewed: 1, published: 0, deferred: 1, failed: 0 })
    expect(f.l1.claims()).toEqual([])
    expect(f.v4.snapshot().facts).toHaveLength(0)
    expect(JSON.stringify(f.extractions.list()[0])).toBe(original)
    expect(f.l1.reviews()[0]?.status).toBe('pending')
  })

  it('does not override user decisions or publish a deleted source', async () => {
    const rejected = fixture()
    rejected.l1.recordReview(rejectGraphClaim(rejected.review, 'not true'))
    expect((await rejected.reassess()).published).toBe(0)
    expect(rejected.l1.reviews()[0]?.status).toBe('rejected')
    const deferred = fixture()
    deferred.l1.recordReview(deferGraphClaim(deferred.review, 'need context'))
    expect((await deferred.reassess()).published).toBe(0)
    const deleted = fixture()
    deleted.source.status = 'deleted'
    expect((await deleted.reassess()).published).toBe(0)
    expect(deleted.v4.snapshot().facts).toHaveLength(0)
  })

  it('does not turn either a low-score UIE candidate or a question into an automatic fact', async () => {
    const low = fixture('我喜欢喝牛奶巧克力。', 0.58)
    expect((await low.reassess()).published).toBe(0)
    expect(low.run.factCandidates[0]?.modelScore).toBe(0.58)
    const question = fixture('我喜欢喝牛奶巧克力吗？')
    expect((await question.reassess()).published).toBe(0)
    expect(question.l1.claims()).toEqual([])
  })
})
