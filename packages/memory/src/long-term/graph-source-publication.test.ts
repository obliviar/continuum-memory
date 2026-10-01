import { describe, expect, it } from 'vitest'
import { autoNormalizeUieGraphFact } from './graph-auto-identity'
import { assessGraphClaim, createGraphL1Store, createGraphL1Writer, rejectGraphClaim, deferGraphClaim } from './graph-l1-write'
import { createGraphPredicateRegistry, type GraphEntityRecord } from './graph-identity-normalization'
import { parseUieOutput, uieGraphExtractionRun } from './local-uie'
import { createMemoryV4Repository } from '../v4/repository/memory-v4-repository'

const scope = { ownerId: 'o', agentId: 'a' }
const privacy = { sensitivity: 'private', sharePolicy: 'local-only' } as const
function fixture(text = '我喜欢喝牛奶巧克力。', score = 0.58, sourceId = 's1') {
  const value = '牛奶巧克力', start = text.indexOf(value)
  const run = uieGraphExtractionRun(sourceId, text, parseUieOutput(text,
    { 喜好: [{ text: value, start, end: start + value.length, probability: score }] }))
  const automatic = autoNormalizeUieGraphFact(run, run.factCandidates[0]!.id, { entities: [], aliases: [], scope })!
  const fact = automatic?.normalized.facts[0]!
  const v4 = createMemoryV4Repository(), l1 = createGraphL1Store({ load: () => undefined, save: () => {} })
  const writer = createGraphL1Writer(v4, l1, createGraphPredicateRegistry(), scope)
  return { run, automatic, fact, v4, l1, writer, review: fact ? assessGraphClaim(run, fact, privacy) : undefined }
}

describe('L1 source-record publication without confidence/context review gates', () => {
  it.each([0, 0.1, 0.58])('publishes a clear self statement at score %s with its original evidence and confidence', async score => {
    const f = fixture(undefined, score)
    expect((await f.writer.submit(f.run, f.fact, f.review!, f.automatic.entities))?.state).toBe('published')
    expect(f.l1.claims()[0]).toMatchObject({ polarity: 'positive', modality: 'asserted', review: { reviewer: 'policy' } })
    expect(f.l1.claims()[0]!.atom.args.subject).toMatchObject({ ref: { id: expect.stringMatching(/^owner-entity:/) } })
    expect(f.v4.snapshot().facts[0]).toMatchObject({ extractionScore: score, userConfirmed: false,
      canonicalText: '我喜欢喝牛奶巧克力', metadata: { verificationMeaning: 'source-alignment-not-world-truth', proactivePreference: false } })
  })
  it('uses a stable self identity across sources without crossing owners or agents', () => {
    const first = fixture(), second = fixture(undefined, 0.2, 's2')
    const subject = (entities: GraphEntityRecord[]) => entities.find(e => e.canonicalName === '我')!.ref.id
    expect(subject(first.automatic.entities)).toBe(subject(second.automatic.entities))
    const foreign = autoNormalizeUieGraphFact(first.run, first.run.factCandidates[0]!.id,
      { entities: [], aliases: [], scope: { ...scope, agentId: 'b' } })!
    expect(subject(foreign.entities)).not.toBe(subject(first.automatic.entities))
  })
  it('publishes unknown context without upgrading polarity, modality, identity or frame', async () => {
    const f = fixture('我可能喜欢喝牛奶巧克力。')
    await f.writer.submit(f.run, f.fact, f.review!, f.automatic.entities)
    expect(f.l1.claims()[0]).toMatchObject({ polarity: 'unknown', modality: 'unknown' })
    expect(f.l1.contexts()[0]).toMatchObject({ scenario: 'unknown', frame: { isolation: 'claim' } })
    expect(f.automatic.entities.find(e => e.canonicalName === '我')!.ref.id).toMatch(/^source-entity:/)
  })
  it('never merges two named subjects merely because the name matches', () => {
    const text = '小陈住在成都。', raw = { 人物: [{ text: '小陈', start: 0, end: 2, probability: 0.2,
      relations: { 居住地: [{ text: '成都', start: 4, end: 6, probability: 0.2 }] } }],
      地点: [{ text: '成都', start: 4, end: 6, probability: 0.2 }] }
    const first = uieGraphExtractionRun('one', text, parseUieOutput(text, raw))
    const a = autoNormalizeUieGraphFact(first, first.factCandidates[0]!.id, { entities: [], aliases: [], scope })!
    const second = uieGraphExtractionRun('two', text, parseUieOutput(text, raw))
    const b = autoNormalizeUieGraphFact(second, second.factCandidates[0]!.id, { entities: a.entities, aliases: [], scope })!
    const subjectId = (value: typeof a) => (value.normalized.facts[0]!.arguments!.subject as { entityId: string }).entityId
    expect(subjectId(a)).not.toBe(subjectId(b))
  })
  it('keeps reviewed rejections and explicit deferrals even when source auto-publication becomes possible', async () => {
    for (const review of [rejectGraphClaim, deferGraphClaim]) {
      const f = fixture()
      f.l1.recordReview(review(f.review!, 'user decision'))
      expect(await f.writer.submit(f.run, f.fact, f.review!, f.automatic.entities)).toBeUndefined()
      expect(f.l1.claims()).toHaveLength(0)
      expect(f.v4.snapshot().facts).toHaveLength(0)
    }
  })
  it('rejects wrong spans or changed source hashes by machine rather than requesting review', async () => {
    for (const tamper of ['hash', 'span'] as const) {
      const f = fixture()
      if (tamper === 'hash') f.run.sourceRevision = 'wrong'
      else f.run.entityMentions.find(m => m.id === f.run.factCandidates[0]!.subjectMentionId)!.text = 'not in source'
      expect(autoNormalizeUieGraphFact(f.run, f.fact.sourceFactId, { entities: [], aliases: [], scope })).toBeUndefined()
      expect(assessGraphClaim(f.run, f.fact, privacy).status).toBe('rejected')
      await expect(f.writer.submit(f.run, f.fact, { ...f.review!, sourceRevision: f.run.sourceRevision }, f.automatic.entities))
        .rejects.toThrow('exact source evidence')
      expect(f.v4.snapshot().facts).toHaveLength(0)
    }
  })
  it('does not continue a queued publication into a reloaded store', async () => {
    const f = fixture()
    const writer = createGraphL1Writer(f.v4, f.l1, createGraphPredicateRegistry(), scope,
      { isCurrent: () => false, syncFromClaims: async () => {} })
    await expect(writer.submit(f.run, f.fact, f.review!, f.automatic.entities)).rejects.toThrow('reloaded')
    expect(f.l1.tasks()).toHaveLength(0)
    expect(f.v4.snapshot().facts).toHaveLength(0)
  })
})
