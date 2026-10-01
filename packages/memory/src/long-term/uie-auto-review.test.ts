import { describe, expect, it } from 'vitest'
import { autoNormalizeUieGraphFact } from './graph-auto-identity'
import { assessGraphClaim, createGraphL1Store, createGraphL1Writer } from './graph-l1-write'
import { createLocalUieExtractor, localUieScriptPath, parseUieOutput, refreshUieGraphReviewContext,
  uieGraphExtractionRun, uieReviewCandidates } from './local-uie'
import { createLocalMemoryCandidateVerifier } from './memory-write-policy'
import { createGraphPredicateRegistry } from './graph-identity-normalization'
import { createMemoryV4Repository } from '../v4/repository/memory-v4-repository'

const scope = { ownerId: 'owner', agentId: 'agent' }
function extracted(text: string, subject: string, predicate: string, object: string, score = 0.92,
  subjectLabel = '人物', objectLabel = '地点') {
  const item = (value: string) => {
    const start = Array.from(text.slice(0, text.indexOf(value))).length
    return { text: value, start, end: start + Array.from(value).length, probability: score }
  }
  return parseUieOutput(text, { [subjectLabel]: [{ ...item(subject), relations: { [predicate]: [item(object)] } }],
    [objectLabel]: [item(object)] })
}

describe('grounded UIE auto review', () => {
  it('automatically admits a clear ordinary memory and a source-local graph fact', async () => {
    const text = '阿澈住在成都。'
    const extraction = extracted(text, '阿澈', '居住地', '成都')
    const candidate = uieReviewCandidates(text, extraction)[0]!
    expect(candidate.metadata.requiresReview).toBe(false)
    const result = await createLocalMemoryCandidateVerifier()(candidate, {
      turn: { userMessage: text, assistantMessage: '' }, scope,
      matches: { activeByMemoryKey: [] },
    })
    expect(result.status).toBe('accepted')
    const run = uieGraphExtractionRun('source-1', text, extraction)
    expect(run.factCandidates).toHaveLength(1)
    expect(run.sourceText.slice(run.factCandidates[0]!.evidenceSpan.start, run.factCandidates[0]!.evidenceSpan.end))
      .toBe('阿澈住在成都')
    const automatic = autoNormalizeUieGraphFact(run, run.factCandidates[0]!.id,
      { entities: [], aliases: [], scope })!
    expect(automatic.normalized.facts[0]?.status).toBe('ready')
    expect(automatic.entities).toHaveLength(2)
    expect(automatic.entities.every(entity => entity.ref.id.startsWith('source-entity:'))).toBe(true)
    const review = assessGraphClaim(run, automatic.normalized.facts[0]!,
      { sensitivity: 'private', sharePolicy: 'local-only' })
    expect(review.status).toBe('approved')
    let payload: string | undefined
    const l1 = createGraphL1Store({ load: () => payload, save: value => { payload = value } })
    const v4 = createMemoryV4Repository()
    const writer = createGraphL1Writer(v4, l1, createGraphPredicateRegistry(), scope)
    expect((await writer.submit(run, automatic.normalized.facts[0]!, review, automatic.entities))?.state)
      .toBe('published')
    expect(l1.claims()[0]).toMatchObject({ sensitivity: 'private', sharePolicy: 'local-only' })
    expect(v4.snapshot().facts).toHaveLength(1)
    const other = uieGraphExtractionRun('source-2', text, extraction)
    const otherEntities = autoNormalizeUieGraphFact(other, other.factCandidates[0]!.id,
      { entities: [], aliases: [], scope })!.entities
    expect(otherEntities[0]?.ref.id).not.toBe(automatic.entities[0]?.ref.id)
  })

  it.each([
    ['阿澈在星河科技工作。', '阿澈', '所属组织', '星河科技', '人物', '企业', 'affiliatedWith'],
    ['星河科技的董事长是阿澈。', '星河科技', '董事长', '阿澈', '企业', '人物', 'chairedBy'],
  ])('supports clear registered graph relations: %s', (text, subject, predicate, object, subjectLabel, objectLabel, expected) => {
    const extraction = extracted(text, subject, predicate, object, 0.92, subjectLabel, objectLabel)
    expect(uieReviewCandidates(text, extraction)[0]?.metadata.requiresReview).toBe(false)
    const run = uieGraphExtractionRun('source', text, extraction)
    const automatic = autoNormalizeUieGraphFact(run, run.factCandidates[0]!.id,
      { entities: [], aliases: [], scope })!
    expect(automatic.normalized.facts[0]).toMatchObject({ status: 'ready', predicate: expected })
  })

  it('publishes a directly stated first-person preference at 0.82 without relaxing ordinary memory review', async () => {
    const text = '我喜欢喝牛奶巧克力。'
    const value = '牛奶巧克力'
    const start = Array.from(text.slice(0, text.indexOf(value))).length
    const extraction = parseUieOutput(text, { 喜好: [{ text: value, start,
      end: start + Array.from(value).length, probability: 0.82 }] })
    expect(uieReviewCandidates(text, extraction)[0]?.metadata.requiresReview).toBe(true)
    const run = uieGraphExtractionRun('preference-source', text, extraction)
    expect(run.factCandidates).toHaveLength(1)
    expect(run.factCandidates[0]?.predicate).toBe('喜欢')
    const automatic = autoNormalizeUieGraphFact(run, run.factCandidates[0]!.id,
      { entities: [], aliases: [], scope })!
    const fact = automatic.normalized.facts[0]!
    expect(fact).toMatchObject({ status: 'ready', predicate: 'likes' })
    const review = assessGraphClaim(run, fact, { sensitivity: 'private', sharePolicy: 'local-only' })
    expect(review.status).toBe('approved')
    let payload: string | undefined
    const l1 = createGraphL1Store({ load: () => payload, save: value => { payload = value } })
    const v4 = createMemoryV4Repository()
    expect((await createGraphL1Writer(v4, l1, createGraphPredicateRegistry(), scope)
      .submit(run, fact, review, automatic.entities))?.state).toBe('published')
    expect(l1.claims()[0]?.atom.predicate).toBe('likes')
    expect(v4.snapshot().facts).toHaveLength(1)
  })

  it.each(['我不太喜欢喝牛奶巧克力。', '我不再喜欢喝牛奶巧克力。',
    '我可能喜欢喝牛奶巧克力。', '我喜欢喝牛奶巧克力吗？'])('does not auto-publish a risky preference: %s', text => {
    const value = '牛奶巧克力'
    const start = Array.from(text.slice(0, text.indexOf(value))).length
    const extraction = parseUieOutput(text, { 喜好: [{ text: value, start,
      end: start + Array.from(value).length, probability: 0.95 }] })
    const run = uieGraphExtractionRun('risky-preference', text, extraction)
    expect(run.factCandidates).toHaveLength(1)
    expect(autoNormalizeUieGraphFact(run, run.factCandidates[0]!.id,
      { entities: [], aliases: [], scope })).toBeUndefined()
  })

  it('can safely re-evaluate retained raw UIE context without mutating the original run', () => {
    const text = '我喜欢喝牛奶巧克力。'
    const value = '牛奶巧克力'
    const start = Array.from(text.slice(0, text.indexOf(value))).length
    const extraction = parseUieOutput(text, { 喜好: [{ text: value, start,
      end: start + Array.from(value).length, probability: 0.82 }] })
    const run = uieGraphExtractionRun('old-preference', text, extraction)
    const old = { ...run, factCandidates: run.factCandidates.map(fact => ({ ...fact,
      context: { negation: { value: null, resolution: 'unresolved' as const },
        condition: { value: null, resolution: 'unresolved' as const },
        time: { value: null, resolution: 'unresolved' as const },
        speaker: { value: null, resolution: 'unresolved' as const } } })) }
    const original = JSON.stringify(old)
    const updated = refreshUieGraphReviewContext(old)!
    expect(updated.id).toBe(old.id)
    expect(updated.factCandidates[0]?.context.negation).toMatchObject({ value: false, resolution: 'resolved' })
    expect(JSON.stringify(old)).toBe(original)
  })

  it.skipIf(!process.env.CONTINUUM_MEMORY_UIE_PYTHON || !process.env.CONTINUUM_MEMORY_UIE_MODEL_PATH)(
    'admits a direct preference extracted by the installed UIE model', async () => {
      const extractor = createLocalUieExtractor({ pythonPath: process.env.CONTINUUM_MEMORY_UIE_PYTHON!,
        modelPath: process.env.CONTINUUM_MEMORY_UIE_MODEL_PATH!, modelHome: '', scriptPath: localUieScriptPath,
        timeoutMs: 120_000 })
      try {
        const run = uieGraphExtractionRun('installed-model-preference', '我喜欢喝牛奶巧克力。',
          await extractor.extract('我喜欢喝牛奶巧克力。'))
        const candidate = run.factCandidates.find(item => item.predicate === '喜欢')
        expect(candidate).toBeDefined()
        expect(candidate!.modelScore).toBeGreaterThanOrEqual(0.7)
        const automatic = autoNormalizeUieGraphFact(run, candidate!.id,
          { entities: [], aliases: [], scope })!
        expect(automatic).toBeDefined()
        const fact = automatic.normalized.facts.find(item => item.sourceFactId === candidate!.id)!
        const review = assessGraphClaim(run, fact, { sensitivity: 'private', sharePolicy: 'local-only' })
        expect(review.status).toBe('approved')
        let payload: string | undefined
        const l1 = createGraphL1Store({ load: () => payload, save: value => { payload = value } })
        const v4 = createMemoryV4Repository()
        expect((await createGraphL1Writer(v4, l1, createGraphPredicateRegistry(), scope)
          .submit(run, fact, review, automatic.entities))?.state).toBe('published')
        expect(l1.claims()).toHaveLength(1)
        expect(v4.snapshot().facts).toHaveLength(1)
      }
      finally { extractor.dispose() }
    }, 180_000)

  it.each(['如果阿澈住在成都，就通知我。', '听说阿澈住在成都。', '阿澈不住在成都。',
    '阿澈明天住在成都。', '阿澈住在成都吗？'])('keeps uncertain context in manual review: %s', text => {
    const extraction = extracted(text, '阿澈', '居住地', '成都')
    expect(uieReviewCandidates(text, extraction)[0]?.metadata.requiresReview).toBe(true)
    const run = uieGraphExtractionRun('source', text, extraction)
    expect(autoNormalizeUieGraphFact(run, run.factCandidates[0]!.id,
      { entities: [], aliases: [], scope })).toBeUndefined()
  })

  it('keeps low-confidence and ungrounded labels in review', () => {
    const low = extracted('阿澈住在成都。', '阿澈', '居住地', '成都', 0.8)
    expect(uieReviewCandidates('阿澈住在成都。', low)[0]?.metadata.requiresReview).toBe(true)
    const ungrounded = extracted('阿澈去了成都。', '阿澈', '居住地', '成都')
    expect(uieReviewCandidates('阿澈去了成都。', ungrounded)[0]?.metadata.requiresReview).toBe(true)
    const mixed = '阿澈去了成都，李明住在北京。'
    const crossClause = extracted(mixed, '阿澈', '居住地', '成都')
    expect(uieReviewCandidates(mixed, crossClause)[0]?.metadata.requiresReview).toBe(true)
  })
})
