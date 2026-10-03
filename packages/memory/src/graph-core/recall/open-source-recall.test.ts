import { describe, expect, it } from 'vitest'
import { createCaptureRepository } from '../../long-term/capture-repository'
import { createGraphExtractionResultStore } from '../../long-term/graph-extraction-result'
import { parseUieOutput, uieGraphExtractionRun, createUieRuleFallbackExtractor, createLocalUieExtractor, localUieScriptPath } from '../../long-term/local-uie'
import { planUieSchema } from '../../long-term/uie-schema-planner'
import { includesRecallTerm, recallOpenSources } from './open-source-recall'
import { projectOpenAssertions } from '../repository/open-assertions'

function disk() { let value: string | undefined; return { load: () => value, save: (v: string) => { value = v } } }
const scope = { ownerId: 'o', agentId: 'a' }
function fixture() {
  const captures = createCaptureRepository({ persistence: disk() }), extractions = createGraphExtractionResultStore(disk())
  const add = (id: string, text: string, graph = true, target = scope) => {
    captures.register({ userMessage: text, assistantMessage: '', metadata: { sourceMessageIds: [id] } }, target, 'test')
    if (graph) extractions.append(uieGraphExtractionRun(id, text, parseUieOutput(text, {})))
  }
  const recall = (query: string, options = {}) => recallOpenSources({ captures: captures.snapshot(), extractions,
    scope, query, canRead: () => true, ...options })
  return { captures, extractions, add, recall }
}
describe('production open source navigation', () => {
  it('finds an existing outage across storage and power links without publishing or reviewing facts', () => {
    const f = fixture()
    f.add('s1', '样品S7存放在恒温箱B2。')
    f.add('s2', '恒温箱B2使用电源插座P3。')
    f.add('s3', '插座P3发生断电。')
    const hits = f.recall('样品S7相关的历史记忆')
    expect(hits.map(h => h.content)).toEqual(['样品S7存放在恒温箱B2。', '恒温箱B2使用电源插座P3。', '插座P3发生断电。'])
    expect(hits[2]?.path).toHaveLength(2)
    expect(hits[2]?.path.map(p => p.relation)).toEqual(['存放在', '使用电源'])
    expect(f.recall('样品S7', { maxHops: 0 })).toHaveLength(1)
    expect(f.recall('样品S7', { maxHops: 1 })).toHaveLength(2)
    expect(f.extractions.openReviews()).toEqual([])
  })
  it('keeps negation and conditional sources, handles empty extraction and exact identifiers', () => {
    const f = fixture()
    f.add('n1', '如果搬家，物件N1不存放在冷柜C3。')
    f.add('n11', '物件N11存放在箱子C4。')
    f.add('zero', '物件Z91怕光，需要黑色包装。', false)
    expect(f.recall('物件N1').map(h => h.content)).toEqual(['如果搬家，物件N1不存放在冷柜C3。'])
    expect(f.recall('物件Z91')).toHaveLength(1)
    expect(includesRecallTerm('物件N11', '物件N1')).toBe(false)
    expect(includesRecallTerm('物件N1', '物件N11')).toBe(false)
  })
  it('does not use a same-name person as a bridge or traverse unreadable sources', () => {
    const f = fixture()
    f.add('p1', '同事小陈负责项目M1。')
    f.add('p2', '邻居小陈负责项目M2。')
    expect(f.recall('项目M1')).toHaveLength(1)
    f.add('s1', '样品S7存放在恒温箱B2。')
    f.add('s2', '恒温箱B2使用电源插座P3。')
    f.add('s3', '插座P3发生断电。')
    expect(f.recall('样品S7', { canRead: (s: { messageIds: string[] }) => !s.messageIds.includes('s2') })).toHaveLength(1)
    f.add('foreign', '样品S7发生泄漏。', true, { ...scope, agentId: 'b' })
    expect(f.recall('样品S7').some(h => h.content.includes('泄漏'))).toBe(false)
  })
  it('honors rejection, deletion, revisions, secret filtering, node and output budgets', () => {
    const f = fixture()
    f.add('s1', '样品S7存放在恒温箱B2。')
    const hit = f.recall('样品S7')[0]!
    expect(f.recall('样品S7', { maxCharacters: 1 })).toEqual([])
    f.captures.invalidate(scope, ['s1'])
    expect(f.recall('样品S7')).toEqual([])
    f.add('s2', '样品S8存放在恒温箱B3。')
    const record = projectOpenAssertions(f.captures.snapshot(), f.extractions, scope)[0]!
    f.extractions.recordOpenReview({ assertionId: record.ref.id, sourceId: record.extraction.sourceId,
      sourceRevision: record.extraction.sourceRevision, status: 'rejected', reason: 'user rejected', reviewedAt: Date.now() })
    expect(f.recall('样品S8')).toEqual([])
    expect(hit.source.end - hit.source.start).toBe(hit.content.length)
    f.add('secret', '设备SECRET的密码是abc。', false)
    expect(f.recall('设备SECRET')).toEqual([])
    expect(f.recall('样品S8', { maxNodes: 0 })).toEqual([])
  })
  it('uses an unfamiliar UIE relation label without approving a canonical predicate', () => {
    const f = fixture(), text = '样品U7保管于恒温箱U2'
    f.add('uie-open', text, false)
    f.extractions.append(uieGraphExtractionRun('uie-open', text, parseUieOutput(text, {
      样品: [{ text: '样品U7', start: 0, end: 4, probability: 0.65,
        relations: { 保管于: [{ text: '恒温箱U2', start: 7, end: 12, probability: 0.65 }] } }],
    })))
    f.add('related', '恒温箱U2发生温控故障。')
    expect(f.recall('样品U7').map(h => h.content)).toEqual([text, '恒温箱U2发生温控故障。'])
    expect(f.extractions.openReviews()).toEqual([])
    f.add('uie-open', '样品U7已经移走。', false)
    expect(f.recall('样品U7').map(h => h.content)).toEqual(['样品U7已经移走。'])
  })
  it('passes automatically selected schemas to UIE while preserving raw results', async () => {
    let used: unknown
    const text = '样品S7存放在恒温箱B2。'
    const extractor = createUieRuleFallbackExtractor({ adaptiveSchema: true,
      uie: { extract: async (_text, schema) => { used = schema; return parseUieOutput(text, {}) } } })
    await extractor({ userMessage: text, assistantMessage: '' })
    expect(used).toEqual(planUieSchema(text).schema)
    expect(planUieSchema(text).domains).toEqual(['experiment'])
    expect(planUieSchema('模块A依赖于模块B').domains).toEqual(['software'])
    expect(planUieSchema('我喜欢巧克力').schema).toContain('喜欢')
  })
  it('bridges typed unnumbered equipment but does not treat an arbitrary human label as an object', () => {
    const f = fixture()
    const addTyped = (id: string, text: string, label: string, subject: string, relation: string, object: string) => {
      f.add(id, text, false)
      const start = text.indexOf(subject), objectStart = text.indexOf(object)
      f.extractions.append(uieGraphExtractionRun(id, text, parseUieOutput(text, {
        [label]: [{ text: subject, start, end: start + subject.length, probability: 0.8,
          relations: { [relation]: [{ text: object, start: objectStart, end: objectStart + object.length, probability: 0.8 }] } }],
      })))
    }
    addTyped('box1', '蓝色恒温箱存放样品Q7。', '设备', '蓝色恒温箱', '存放', '样品Q7')
    addTyped('box2', '蓝色恒温箱出现温控故障。', '设备', '蓝色恒温箱', '出现', '温控故障')
    expect(f.recall('样品Q7').map(h => h.content)).toEqual(['蓝色恒温箱存放样品Q7。', '蓝色恒温箱出现温控故障。'])
    addTyped('person1', '小陈负责项目R1。', '负责人', '小陈', '负责', '项目R1')
    addTyped('person2', '小陈负责项目R2。', '负责人', '小陈', '负责', '项目R2')
    expect(f.recall('项目R1')).toHaveLength(1)
  })
  it.skipIf(!process.env.CONTINUUM_MEMORY_UIE_PYTHON || !process.env.CONTINUUM_MEMORY_UIE_MODEL_PATH)(
    'runs the installed model with adaptive schemas and follows the resulting source chain', async () => {
      const f = fixture()
      const model = createLocalUieExtractor({ pythonPath: process.env.CONTINUUM_MEMORY_UIE_PYTHON!,
        modelPath: process.env.CONTINUUM_MEMORY_UIE_MODEL_PATH!, modelHome: '', scriptPath: localUieScriptPath, timeoutMs: 120000 })
      const extractor = createUieRuleFallbackExtractor({ uie: model, adaptiveSchema: true,
        onError: error => { console.error('LIVE_UIE_FAILURE', error) },
        onGraphExtraction: (_turn, run) => { f.extractions.append(run) } })
      try {
        for (const [i, text] of ['样品S7存放在恒温箱B2。', '恒温箱B2使用电源插座P3。', '插座P3发生断电。'].entries()) {
          const id = `live${i}`
          f.add(id, text, false)
          await extractor({ userMessage: text, assistantMessage: '', metadata: { sourceMessageIds: [id] } })
        }
        expect(f.extractions.list().every(run => run.modelId === 'uie-base')).toBe(true)
        expect(f.recall('样品S7')).toHaveLength(3)
        console.info('LIVE_ADAPTIVE_UIE', JSON.stringify(f.extractions.list().map(run => ({
          source: run.sourceId, facts: run.factCandidates.length, localRelations: run.assertionCandidates?.length,
          schema: (run.rawOutput as { extractionSchema: unknown }).extractionSchema }))))
      } finally { model.dispose() }
    }, 180000)
})
