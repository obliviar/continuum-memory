import { describe, expect, it } from 'vitest'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assessGraphClaim, confirmGraphClaim, confirmGraphFactIdentities,
  createGraphL1Store, createGraphL1Writer, createGraphPredicateRegistry,
  createMemoryV4Repository, normalizeGraphExtraction } from '@continuum-memory/memory'
import { createLocalUieExtractor, parseUieOutput, uieGraphExtractionRun, uieReviewCandidates } from './uie-extractor'

describe('local UIE-base output adapter', () => {
  it.skipIf(!process.env.CONTINUUM_MEMORY_UIE_PYTHON || !process.env.CONTINUUM_MEMORY_UIE_MODEL_PATH)(
    'loads the installed local model and extracts source-aligned mentions', async () => {
      const extractor = createLocalUieExtractor({
        pythonPath: process.env.CONTINUUM_MEMORY_UIE_PYTHON!,
        modelPath: process.env.CONTINUUM_MEMORY_UIE_MODEL_PATH!,
        modelHome: '',
        scriptPath: join(dirname(fileURLToPath(import.meta.url)), '../../resources/uie_extract.py'),
        timeoutMs: 120_000,
      })
      expect(extractor.isReady()).toBe(true)
      const text = '张三在星河公司工作。'
      const result = await extractor.extract(text)
      expect(result.rawOutput).toBeDefined()
      expect(result.entities.length).toBeGreaterThan(0)
      for (const mention of result.entities)
        expect(Array.from(text).slice(mention.start, mention.end).join('')).toBe(mention.text)
      const run = uieGraphExtractionRun('test-message', text, result)
      expect(run.status).not.toBe('failed')
      expect((run.rawOutput as { uieRawOutput: unknown }).uieRawOutput).toEqual(result.rawOutput)
      const affiliation = run.factCandidates.find(fact => fact.predicate === '所属组织')
      expect(affiliation).toBeDefined()
      const scope = { ownerId: 'test-owner', agentId: 'test-agent' }
      const entities = [
        { ref: { kind: 'entity' as const, id: 'person-zhang', version: 1 }, scope,
          entityType: 'person', canonicalName: '张三', aliases: [] },
        { ref: { kind: 'entity' as const, id: 'org-xinghe', version: 1 }, scope,
          entityType: 'organization', canonicalName: '星河公司', aliases: [] },
      ]
      const normalized = normalizeGraphExtraction(run, { entities, scope,
        explicitIdentityByMentionId: {
          [affiliation!.subjectMentionId]: 'person-zhang',
          ...('mentionId' in affiliation!.object ? { [affiliation!.object.mentionId]: 'org-xinghe' } : {}),
        } })
      const fact = normalized.facts.find(item => item.sourceFactId === affiliation!.id)!
      expect(fact).toMatchObject({ status: 'ready', predicate: 'affiliatedWith' })
      expect(assessGraphClaim(run, fact, { sensitivity: 'private', sharePolicy: 'local-only' }).status).toBe('pending')
      const confirmed = confirmGraphFactIdentities(run, affiliation!.id,
        { entities: [], aliases: [], scope })
      const readyFact = confirmed.normalized.facts.find(item => item.sourceFactId === affiliation!.id)!
      const review = confirmGraphClaim(assessGraphClaim(run, readyFact,
        { sensitivity: 'private', sharePolicy: 'local-only' }), 'Source verified')
      const v4 = createMemoryV4Repository()
      const l1 = createGraphL1Store({ load: () => undefined, save: () => {} })
      const publication = await createGraphL1Writer(v4, l1, createGraphPredicateRegistry(), scope)
        .submit(run, readyFact, review, confirmed.entities)
      expect(publication?.state).toBe('published')
      expect(v4.snapshot().factVersions).toHaveLength(1)
      expect(l1.claims()[0]?.atom.predicate).toBe('affiliatedWith')
    }, 150_000)
  it('deduplicates root spans and preserves nested relation evidence', () => {
    const text = '《雪满庭》由祝云舟主演。'
    const raw = {
      影视作品: [
        {
          text: '雪满庭', start: 1, end: 4, probability: 0.96,
          relations: { 主演: [{ text: '祝云舟', start: 6, end: 9, probability: 0.91 }] },
        },
        { text: '雪满庭', start: 1, end: 4, probability: 0.96 },
      ],
      人物: [{ text: '祝云舟', start: 6, end: 9, probability: 0.94 }],
    }
    const result = parseUieOutput(text, raw)
    expect(result.entities).toHaveLength(2)
    expect(result.relations).toMatchObject([
      { subject: { text: '雪满庭' }, predicate: '主演', object: { text: '祝云舟' }, score: 0.91 },
    ])
    expect(uieReviewCandidates(text, result)).toMatchObject([
      { content: '雪满庭的主演：祝云舟', metadata: { requiresReview: true, sharePolicy: 'local-only' } },
    ])
  })

  it('rejects hallucinated spans and does not infer a user identity from a third party', () => {
    const text = '他说张三住在北京。'
    const result = parseUieOutput(text, {
      姓名: [{ text: '张三', start: 2, end: 4, probability: 0.99 }],
      地点: [{ text: '上海', start: 6, end: 8, probability: 0.99 }],
    })
    expect(result.entities).toEqual([])
    expect(uieReviewCandidates(text, result)).toEqual([])
  })

  it('turns an explicit first-person field into a review-only memory candidate', () => {
    const text = '我叫张三。'
    const result = parseUieOutput(text, {
      姓名: [{ text: '张三', start: 2, end: 4, probability: 0.98 }],
    })
    expect(uieReviewCandidates(text, result)).toMatchObject([
      {
        content: '用户姓名/名字：张三',
        metadata: { predicate: 'profile.name', requiresReview: true, confidence: 0.98 },
      },
    ])
  })

  it('uses code-point offsets when text contains emoji', () => {
    const result = parseUieOutput('🙂张三', {
      人物: [{ text: '张三', start: 1, end: 3, probability: 0.8 }],
    })
    expect(result.entities[0]).toMatchObject({ text: '张三', start: 1, end: 3 })
  })

  it('retains raw UIE output and converts every relation to source-aligned graph candidates', () => {
    const text = '🙂张三工作于星河公司。'
    const raw = { 人物: [{ text: '张三', start: 1, end: 3, probability: 0.92,
      relations: { 工作于: [{ text: '星河公司', start: 6, end: 10, probability: 0.88 }] } }],
    企业: [{ text: '星河公司', start: 6, end: 10, probability: 0.91 }] }
    const parsed = parseUieOutput(text, raw)
    const run = uieGraphExtractionRun('message-1', text, parsed)
    expect((run.rawOutput as { uieRawOutput: unknown }).uieRawOutput).toEqual(raw)
    expect(run.entityMentions).toMatchObject([{ text: '张三', span: { start: 2, end: 4 } },
      { text: '星河公司', span: { start: 7, end: 11 } }])
    expect(run.factCandidates[0]).toMatchObject({ predicate: '工作于', modelScore: 0.88,
      evidenceSpan: { start: 2, end: 11 }, context: { negation: { resolution: 'unresolved' } } })
  })
})
