import { describe, expect, it } from 'vitest'
import { createLocalUieExtractor, localUieScriptPath, parseUieOutput, uieGraphExtractionRun } from './local-uie'
import { createGraphPredicateRegistry, normalizeGraphExtraction, type GraphEntityRecord } from './graph-identity-normalization'
import { assessGraphClaim, confirmGraphClaim, createGraphL1Store, createGraphL1Writer, rejectGraphClaim } from './graph-l1-write'
import { confirmGraphFactIdentities } from './graph-confirmed-identity'
import { reviewGraphAdmission } from './graph-admission-review'
import { createMemoryV4Repository } from '../v4/repository/memory-v4-repository'
import { createGraphSemanticRepository } from '../graph-core/repository/semantic-repository'
import { createGraphL1ProjectionRepository } from '../graph-core/repository/l1-projection-repository'
import { createGraphNormalizationStore } from './graph-normalization-store'
import { graphSourcesWithoutFactCandidates, recoverGraphClaimReviews } from './graph-review-recovery'
import type { GraphExtractionRun } from './graph-extraction-result'

const scope = { ownerId: 'test-owner', agentId: 'test-agent' }
const privacy = { sensitivity: 'private', sharePolicy: 'local-only' } as const
function storage() {
  let payload: string | undefined
  return { load: () => payload, save: (value: string) => { payload = value } }
}
function field(text: string, value: string, probability = 0.8) {
  const start = Array.from(text.slice(0, text.indexOf(value))).length
  return { text: value, start, end: start + Array.from(value).length, probability }
}
function run(text: string, raw: unknown, sourceId = 'test-source') {
  return uieGraphExtractionRun(sourceId, text, parseUieOutput(text, raw))
}
function courses() {
  const text = '我每周三都要上电磁学和复变函数'
  return run(text, { 课程: [field(text, '电磁学', 0.758), field(text, '复变函数', 0.738)],
    职业: [field(text, '电磁学', 0.502)] })
}

async function publishAfterReview(extraction: GraphExtractionRun) {
  const registry = createGraphPredicateRegistry()
  const persistence = storage()
  let l1 = createGraphL1Store(persistence)
  const v4 = createMemoryV4Repository()
  let writer = createGraphL1Writer(v4, l1, registry, scope)
  const normalized = normalizeGraphExtraction(extraction, { entities: [], scope })
  for (const fact of normalized.facts) {
    const review = assessGraphClaim(extraction, fact, privacy)
    expect(review.status).toBe('pending')
    expect(await writer.submit(extraction, fact, review, [])).toBeUndefined()
  }
  // A real reload, not just the writer's in-memory state, must expose the pending reviews.
  l1 = createGraphL1Store(persistence)
  expect(l1.reviews()).toHaveLength(extraction.factCandidates.length)
  expect(l1.claims()).toHaveLength(0)
  expect(l1.tasks()).toHaveLength(0)
  expect(v4.snapshot().facts).toHaveLength(0)
  const semantic = createGraphSemanticRepository(storage(), v4)
  const projection = createGraphL1ProjectionRepository(storage(), semantic, v4, l1)
  writer = createGraphL1Writer(v4, l1, registry, scope, { syncFromClaims: async () => {
    const result = await semantic.syncFromClaims(l1, v4, registry, scope)
    expect(result.ok).toBe(true)
    expect(projection.sync()).toBeDefined()
  } })
  const original = JSON.stringify(extraction)
  let entities: GraphEntityRecord[] = []
  for (const pending of l1.reviews()) {
    const source = extraction.factCandidates.find(item => item.id === pending.sourceFactId)!
    const identities = Object.fromEntries([source.subjectMentionId,
      ...('mentionId' in source.object ? [source.object.mentionId] : [])].map(id => [id, 'new']))
    const confirmed = confirmGraphFactIdentities(extraction, source.id,
      { entities, aliases: [], scope, choicesByMentionId: identities })
    entities = confirmed.entities
    const fact = confirmed.normalized.facts.find(item => item.sourceFactId === source.id)!
    const admission = reviewGraphAdmission(extraction, source.id,
      { negation: 'positive', condition: 'none', time: 'unknown', speaker: 'self' }, identities)
    const review = confirmGraphClaim(pending, 'Verified exact source, identity and context')
    expect((await writer.submit(extraction, fact, review, entities, admission))?.state).toBe('published')
    // Retrying an old policy assessment must not roll back the user's accepted review.
    await writer.submit(extraction, fact, pending, entities)
  }
  expect(l1.reviews().every(item => item.status === 'approved')).toBe(true)
  expect(l1.claims()).toHaveLength(extraction.factCandidates.length)
  expect(projection.snapshot()?.semanticBundle.claims).toHaveLength(extraction.factCandidates.length)
  expect(JSON.stringify(extraction)).toBe(original)
  return l1
}

describe('UIE conversational fields and durable graph review', () => {
  it('keeps both courses and their weekly evidence, discarding the spurious occupation label', async () => {
    const extraction = courses()
    expect(extraction.status).toBe('complete')
    expect(extraction.factCandidates.map(item => item.predicate)).toEqual(['修读课程', '修读课程'])
    expect(extraction.factCandidates.every(item => item.context.time.resolution === 'unresolved')).toBe(true)
    expect(extraction.factCandidates.map(item => extraction.sourceText.slice(item.evidenceSpan.start, item.evidenceSpan.end)))
      .toEqual([extraction.sourceText, extraction.sourceText])
    const l1 = await publishAfterReview(extraction)
    expect(l1.claims().map(item => item.atom.predicate)).toEqual(['takesCourse', 'takesCourse'])
    expect(l1.claims().every(item => item.validTime.kind === 'unknown')).toBe(true)
  })

  it('binds a teaching location without attributing an unrelated laboratory course', async () => {
    const text = '我一般在西区三号教学楼上课，今晚我要去东区做大物实验，要做双臂电桥'
    const extraction = run(text, { 上课地点: [field(text, '西区三号教学楼')], 课程: [field(text, '大物实验')] })
    expect(extraction.factCandidates).toHaveLength(1)
    expect(extraction.factCandidates[0]?.predicate).toBe('上课地点')
    expect((await publishAfterReview(extraction)).claims()[0]?.atom.predicate).toBe('studiesAt')
  })

  it('retains low-score explicit preferences for review and deduplicates overlapping field labels', async () => {
    const text = '其实我很喜欢打乒乓球'
    const extraction = run(text, { 喜欢: [field(text, '打乒乓球', 0.719)], 爱好: [field(text, '乒乓球', 0.615)] })
    expect(extraction.factCandidates).toHaveLength(1)
    expect(extraction.factCandidates[0]).toMatchObject({ predicate: '喜欢', modelScore: 0.719 })
    expect((await publishAfterReview(extraction)).claims()[0]?.atom.predicate).toBe('likes')
  })

  it('keeps a contextual interest reviewable when UIE also labels the same span as a course', async () => {
    const text = '我喜欢数学'
    const extraction = run(text, { 课程: [field(text, '数学')], 喜欢: [field(text, '数学')] })
    expect(extraction.factCandidates).toHaveLength(1)
    expect((await publishAfterReview(extraction)).claims()[0]?.atom.predicate).toBe('likes')
  })

  it.each([
    ['他说他很喜欢打乒乓球', '乒乓球'], ['我叫张三，李四喜欢打篮球', '打篮球'],
    ['我朋友喜欢打篮球', '打篮球'], ['如果有时间，我想打乒乓球', '乒乓球'],
    ['李四说：“我喜欢打篮球”', '打篮球'], ['我喜欢音乐，他喜欢电影', '电影'],
    ['我喜欢的朋友讨厌篮球', '篮球'], ['我们喜欢打篮球', '打篮球'],
  ])('does not manufacture a first-person preference from %s', (text, value) => {
    expect(run(text, { 喜欢: [field(text, value)] }).factCandidates).toHaveLength(0)
  })

  it('preserves negation, condition and Unicode evidence without declaring context resolved', () => {
    const text = '🙂。如果下雨，我不喜欢打篮球'
    const extraction = run(text, { 喜欢: [field(text, '打篮球')] })
    expect(extraction.status).toBe('complete')
    expect(extraction.factCandidates).toHaveLength(1)
    const candidate = extraction.factCandidates[0]!
    expect(extraction.sourceText.slice(candidate.evidenceSpan.start, candidate.evidenceSpan.end)).toBe('如果下雨，我不喜欢打篮球')
    expect(candidate.context.negation.resolution).toBe('unresolved')
    expect(candidate.context.condition.resolution).toBe('unresolved')
    expect(extraction.entityMentions.find(item => item.id === candidate.subjectMentionId)?.text).toBe('我')
  })

  it('rejects a mismatched pending review and preserves an explicit rejection', async () => {
    const extraction = courses()
    const l1 = createGraphL1Store(storage())
    const writer = createGraphL1Writer(createMemoryV4Repository(), l1, createGraphPredicateRegistry(), scope)
    const fact = normalizeGraphExtraction(extraction, { entities: [], scope }).facts[0]!
    const pending = assessGraphClaim(extraction, fact, privacy)
    await expect(writer.submit(extraction, fact, { ...pending, sourceRevision: 'wrong' }, [])).rejects.toThrow('exact source')
    expect(l1.reviews()).toHaveLength(0)
    await writer.submit(extraction, fact, pending, [])
    await writer.submit(extraction, fact, rejectGraphClaim(pending, 'Incorrect extraction'), [])
    await writer.submit(extraction, fact, pending, [])
    expect(l1.reviews()[0]?.status).toBe('rejected')
    expect(l1.tasks()).toHaveLength(0)
  })

  it('recovers dropped reviews after restart without overriding decisions or duplicating entries', () => {
    const extraction = courses()
    const norm = createGraphNormalizationStore(storage())
    const persistence = storage()
    const l1 = createGraphL1Store(persistence)
    expect(recoverGraphClaimReviews([extraction], norm, l1, scope)).toBe(2)
    l1.recordReview(rejectGraphClaim(l1.reviews()[0]!, 'Not my course'))
    const restarted = createGraphL1Store(persistence)
    expect(recoverGraphClaimReviews([extraction], norm, restarted, scope)).toBe(0)
    expect(restarted.reviews().map(item => item.status)).toEqual(['pending', 'rejected'])
    expect(restarted.claims()).toHaveLength(0)
    expect(restarted.tasks()).toHaveLength(0)
    expect(norm.results()).toHaveLength(1)
    expect(recoverGraphClaimReviews([], norm, restarted, scope)).toBe(0)
  })

  it('selects only the latest empty attempt and never re-extracts a source with existing candidates', () => {
    const first = run('我喜欢音乐', {})
    const second = run(first.sourceText, {})
    expect(graphSourcesWithoutFactCandidates([first, second])).toEqual([second])
    const successful = run(first.sourceText, { 喜欢: [field(first.sourceText, '音乐')] })
    expect(graphSourcesWithoutFactCandidates([first, second, successful])).toEqual([])
    expect(graphSourcesWithoutFactCandidates([successful, second])).toEqual([])
    expect(graphSourcesWithoutFactCandidates([first, { ...second, sourceId: 'another-message' }])).toHaveLength(2)
    const attempts = Array.from({ length: 6 }, (_, index) => run('没有关系', {}, `message-${index}`))
    const retried = attempts.slice(0, 5).map(item => run(item.sourceText, {}, item.sourceId))
    expect(graphSourcesWithoutFactCandidates([...attempts, ...retried])[0]?.sourceId).toBe('message-5')
  })

  it.skipIf(!process.env.CONTINUUM_MEMORY_UIE_PYTHON || !process.env.CONTINUUM_MEMORY_UIE_MODEL_PATH)(
    'runs the installed UIE model through persisted pending reviews into the stable L1 view', async () => {
      const extractor = createLocalUieExtractor({ pythonPath: process.env.CONTINUUM_MEMORY_UIE_PYTHON!,
        modelPath: process.env.CONTINUUM_MEMORY_UIE_MODEL_PATH!, modelHome: '', scriptPath: localUieScriptPath, timeoutMs: 120_000 })
      try {
        for (const [text, count] of [
          ['我每周三都要上电磁学和复变函数', 2],
          ['我一般在西区三号教学楼上课，今晚我要去东区做大物实验，要做双臂电桥', 1],
          ['其实我很喜欢打乒乓球', 1], ['张三的父亲是李四。', 1],
        ] as const) {
          const extraction = uieGraphExtractionRun('local-model-test', text, await extractor.extract(text))
          expect(extraction.factCandidates, text).toHaveLength(count)
          await publishAfterReview(extraction)
        }
      }
      finally { extractor.dispose() }
    }, 180_000)
})
