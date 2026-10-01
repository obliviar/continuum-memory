import { describe, expect, it } from 'vitest'
import { createCaptureRepository } from '../../long-term/capture-repository'
import { createGraphExtractionResultStore, createGraphExtractionRun } from '../../long-term/graph-extraction-result'
import { createUieRuleFallbackExtractor } from '../../long-term/local-uie'
import { createGraphPredicateRegistry } from '../../long-term/graph-identity-normalization'
import { createGraphL1Store } from '../../long-term/graph-l1-write'
import { createMemoryV4Repository } from '../../v4/repository/memory-v4-repository'
import { createGraphSemanticRepository } from '../repository/semantic-repository'
import { projectCapturedInformation } from '../repository/captured-information'
import { projectOpenAssertions, searchOpenAssertions } from '../repository/open-assertions'
import { canNavigateOpenAssertion } from '../repository/open-assertion-admission'

// Offline policy prototype ONLY. Does not change desktop admission or publish Claims.
// Extraction observations below are synthetic, not measured UIE model output.
const scope = { ownerId: 'evaluation-owner', agentId: 'evaluation-agent' }
function disk() {
  let payload: string | undefined
  return { load: () => payload, save: (value: string) => { payload = value } }
}
type Example = { id: string; text: string; participants: string[]; relation: string; score?: number; literal?: boolean }
const examples: Example[] = [
  { id: 's1', text: '样品S7存放在恒温箱B2。', participants: ['样品S7', '恒温箱B2'], relation: '存放在' },
  { id: 's2', text: '恒温箱B2发生故障。', participants: ['恒温箱B2', '故障'], relation: '发生' },
  { id: 's3', text: '模块A依赖于模块B。', participants: ['模块A', '模块B'], relation: '依赖于' },
  { id: 's4', text: '模块B连接到设备D。', participants: ['模块B', '设备D'], relation: '连接到' },
  { id: 's5', text: '传感器C安装在设备E。', participants: ['传感器C', '设备E'], relation: '安装在' },
  { id: 's6', text: '晶体F位于衬底G。', participants: ['晶体F', '衬底G'], relation: '位于' },
  { id: 's7', text: '小王把样品H放入冷柜J。', participants: ['小王', '样品H', '冷柜J'], relation: '放入' },
  { id: 's8', text: '文档K保存在目录L。', participants: ['文档K', '目录L'], relation: '保存在' },
  { id: 'q1', text: '样品N1不存放在恒温箱N2。', participants: ['样品N1', '恒温箱N2'], relation: '存放在' },
  { id: 'q2', text: '如果设备修好，样品N3存放在恒温箱N4。', participants: ['样品N3', '恒温箱N4'], relation: '存放在' },
  { id: 'q3', text: '小李说样品N5存放在恒温箱N6。', participants: ['样品N5', '恒温箱N6'], relation: '存放在' },
  { id: 'q4', text: '样品N7可能存放在恒温箱N8。', participants: ['样品N7', '恒温箱N8'], relation: '存放在' },
  { id: 'q5', text: '样品N9存放在恒温箱N10？', participants: ['样品N9', '恒温箱N10'], relation: '存放在' },
  { id: 'q6', text: '我计划把样品N11放入冷柜N12。', participants: ['我', '样品N11', '冷柜N12'], relation: '放入' },
  { id: 'q7', text: '“样品N13存放在恒温箱N14”只是例句。', participants: ['样品N13', '恒温箱N14'], relation: '存放在' },
  { id: 'q8', text: '我把它放入那里。', participants: ['我', '它', '那里'], relation: '放入' },
  { id: 'u1', text: '试剂Q17包好放进靠门的第二个抽屉。', participants: ['试剂Q17', '第二个抽屉'], relation: '存放位置', literal: false },
  { id: 'u2', text: '任务Q18由研发小组甲接手。', participants: ['任务Q18', '研发小组甲'], relation: '负责人', literal: false },
  { id: 'u3', text: '仪器Q19跟着批次Q20一起校验。', participants: ['仪器Q19', '批次Q20'], relation: '联合校验', literal: false },
  { id: 'u4', text: '配置Q21需要运行环境Q22。', participants: ['配置Q21', '运行环境Q22'], relation: '环境依赖', literal: false },
  { id: 'l1', text: '工具R1连接到工具R2。', participants: ['工具R1', '工具R2'], relation: '连接到', score: 0.7 },
  { id: 'l2', text: '零件R3安装在机器R4。', participants: ['零件R3', '机器R4'], relation: '安装在', score: 0.65 },
  { id: 'l3', text: '我把物件R5放入容器R6。', participants: ['我', '物件R5', '容器R6'], relation: '放入', score: 0.8 },
  { id: 'l4', text: '小张负责项目R7。', participants: ['小张', '项目R7'], relation: '负责', score: 0.72 },
]

function fixture() {
  const captures = createCaptureRepository({ persistence: disk() })
  const extractions = createGraphExtractionResultStore(disk())
  const add = (e: Example, targetScope = scope) => {
    captures.register({ userMessage: e.text, assistantMessage: '', metadata: { sourceMessageIds: [e.id] } }, targetScope, 'policy-eval')
    const entities = e.participants.map((text, i) => ({ id: `p${i}`, type: 'unknown', text,
      span: { start: e.text.indexOf(text), end: e.text.indexOf(text) + text.length }, modelScore: e.score ?? 0.95 }))
    const relationStart = e.text.indexOf(e.relation)
    const run = createGraphExtractionRun({ sourceId: e.id, sourceText: e.text, modelId: 'uie-policy-fixture',
      rawOutput: { graph: { entities, facts: [], assertions: [{ id: 'a', relationText: e.relation,
        ...(e.literal === false ? {} : { relationSpan: { start: relationStart, end: relationStart + e.relation.length } }),
        participants: entities.map((entity, i) => ({ mentionId: entity.id, role: i === 0 ? 'subject' : 'participant' })),
        evidenceSpan: { start: 0, end: e.text.length }, modelScore: e.score ?? 0.95 }] } } })
    expect(run.status).toBe('complete')
    extractions.append(run)
  }
  const sourceOnly = (id: string, text: string) => {
    captures.register({ userMessage: text, assistantMessage: '', metadata: { sourceMessageIds: [id] } }, scope, 'policy-eval')
  }
  const current = () => projectOpenAssertions(captures.snapshot(), extractions, scope)
  // Simulates new policy on validated projection. No human accepted status is created.
  const proposed = () => current().map(record => ({ ...record, admission: { ...record.admission!,
    localNavigation: record.review.status === 'rejected' ? 'blocked' as const : 'automatic' as const } }))
  const recall = (query: string, mode: 'old' | 'new', depth = 1) => {
    const records = mode === 'old' ? current() : proposed()
    const hits = searchOpenAssertions({ openAssertions: records }, query, { scope, maximumDepth: depth, limit: 8 })
    const results = new Map<string, { text: string; route: string }>(hits.map(hit => [hit.assertion.extraction.sourceId,
      { text: hit.assertion.sourceContext!.text, route: hit.route }]))
    if (mode === 'new') {
      // Raw-source fallback: literal matching only; no vector or model claim.
      const snapshot = captures.snapshot()
      const rejected = new Set(current().filter(r => r.review.status === 'rejected').map(r => r.source.captureId))
      for (const info of projectCapturedInformation(snapshot, scope)) {
        if (rejected.has(info.source.captureId) || !info.content.includes(query)) continue
        const source = snapshot.sources.find(s => s.id === info.source.captureId)!
        results.set(source.messageIds[0]!, { text: info.content, route: 'source-text' })
      }
    }
    return results
  }
  return { captures, extractions, add, sourceOnly, current, proposed, recall }
}

describe('offline open L1 policy comparison (prototype, synthetic extraction)', () => {
  it('measures admission and source recall with independently specified expected source IDs', () => {
    const f = fixture()
    examples.forEach(e => f.add(e))
    f.sourceOnly('zero1', '编码Z91遇光会变色，需要用黑色包装。')
    f.sourceOnly('zero2', '备忘Z92：下次实验先观察十分钟再记录。')
    const questions = examples.filter(e => e.id !== 'q8').map(e => ({
      query: e.participants.find(p => p.length > 1 && p !== '小王' && p !== '小李' && p !== '小张')!,
      // A query for the box/module is also relevant to the source naming its contents/dependency.
      expected: e.id === 's2' ? ['s1', 's2'] : e.id === 's4' ? ['s3', 's4'] : [e.id], depth: 0 }))
    questions.push({ query: '样品S7', expected: ['s1', 's2'], depth: 1 },
      { query: '模块A', expected: ['s3', 's4'], depth: 1 },
      { query: '编码Z91', expected: ['zero1'], depth: 0 }, { query: '备忘Z92', expected: ['zero2'], depth: 0 },
      { query: '哪种材料需要避光', expected: ['zero1'], depth: 0 })
    function metrics(mode: 'old' | 'new') {
      let tp = 0, returned = 0, expected = 0
      const errors: Array<{ query: string; extra: string[]; missing: string[] }> = []
      for (const q of questions) {
        const result = f.recall(q.query, mode, q.depth)
        tp += q.expected.filter(id => result.has(id)).length
        returned += result.size; expected += q.expected.length
        const extra = [...result.keys()].filter(id => !q.expected.includes(id))
        const missing = q.expected.filter(id => !result.has(id))
        if (extra.length || missing.length) errors.push({ query: q.query, extra, missing })
        if (mode === 'new') for (const [id, hit] of result) {
          const original = examples.find(e => e.id === id)?.text
          if (original) expect(hit.text).toBe(original)
        }
      }
      return { truePositives: tp, returned, expected, recall: tp / expected, precision: returned ? tp / returned : 0, errors }
    }
    const oldPending = f.current().filter(r => !canNavigateOpenAssertion(r)).length
    const newPending = f.proposed().filter(r => !canNavigateOpenAssertion(r)).length
    const old = metrics('old'), next = metrics('new')
    console.info('OPEN_RECALL_COMPARISON', JSON.stringify({ syntheticSources: 26, observations: 24,
      questions: questions.length, confirmationToEnableNavigation: { old: oldPending, proposed: newPending },
      old, proposed: next, syntheticExtraction: true, liveChatChanged: false }))
    expect(oldPending).toBeGreaterThan(0)
    expect(newPending).toBe(0)
    // Report rather than conceal the known substring noise and paraphrase miss.
    expect(next.truePositives).toBe(31)
    expect(next.expected).toBe(32)
    expect(next.errors.some(e => e.query === '哪种材料需要避光' && e.missing.includes('zero1'))).toBe(true)
    expect(next.recall).toBeGreaterThan(old.recall)
    expect(f.extractions.openReviews()).toEqual([])
    expect(f.recall('样品S7', 'new', 0).has('s2')).toBe(false)
    expect(f.recall('样品S7', 'new', 1).has('s2')).toBe(true)
    expect(f.recall('模块A', 'new', 0).has('s4')).toBe(false)
    expect(f.recall('模块A', 'new', 1).has('s4')).toBe(true)
  })

  it('retains negation, conditions, uncertainty, quotations and three participants without rewriting', () => {
    const f = fixture()
    examples.filter(e => e.id.startsWith('q') || e.id === 's7').forEach(e => f.add(e))
    for (const record of f.proposed()) {
      expect(record.sourceContext?.text).toBe(examples.find(e => e.id === record.extraction.sourceId)!.text)
      expect(record.context.negation.resolution).toBe('unresolved')
      expect(record.inferenceAllowed).toBe(false)
      expect(record.review.status).toBe('candidate')
    }
    expect(f.proposed().find(r => r.extraction.sourceId === 's7')?.participants).toHaveLength(3)
  })

  it('exposes homonym noise despite preserving distinct identities', () => {
    const f = fixture()
    f.add({ id: 'name1', text: '同事小陈负责项目M1。', participants: ['小陈', '项目M1'], relation: '负责' })
    f.add({ id: 'name2', text: '邻居小陈负责项目M2。', participants: ['小陈', '项目M2'], relation: '负责' })
    const hits = f.recall('项目M1', 'new', 1)
    expect([...hits.keys()]).toEqual(['name1', 'name2'])
    const mentions = f.proposed().flatMap(r => r.participants.filter(p => p.text === '小陈'))
    expect(new Set(mentions.map(m => m.ref.id)).size).toBe(2)
    console.info('HOMONYM_STRESS', JSON.stringify({ relevant: 1, returned: hits.size, precision: 1 / hits.size,
      identityMerges: 0, conclusion: 'same-name expansion needs context reranking; no guaranteed precision' }))
  })

  it('excludes rejected, deleted, replaced and different-agent records from new recall', () => {
    const f = fixture()
    f.add(examples[0]!)
    const r = f.current()[0]!
    f.extractions.recordOpenReview({ assertionId: r.ref.id, sourceId: r.extraction.sourceId,
      sourceRevision: r.extraction.sourceRevision, status: 'rejected', reason: '停止使用', reviewedAt: Date.now() })
    expect(f.recall('样品S7', 'new').size).toBe(0)
    f.add(examples[1]!, { ...scope, agentId: 'different-agent' })
    expect(f.recall('恒温箱B2', 'new').size).toBe(0)
    f.sourceOnly('delete', '删除样品DEL仍在箱子里。')
    f.captures.invalidate(scope, ['delete'])
    expect(f.recall('删除样品DEL', 'new').size).toBe(0)
    f.sourceOnly('replace', '替换样品OLD仍在箱子里。')
    f.sourceOnly('replace', '替换样品NEW已经移走。')
    expect(f.recall('替换样品OLD', 'new').size).toBe(0)
    expect(f.recall('替换样品NEW', 'new').size).toBe(1)
  })

  it('exercises the real local rule extractor and graph persistence independently of synthetic UIE', async () => {
    const captures = createCaptureRepository({ persistence: disk() })
    const extractions = createGraphExtractionResultStore(disk())
    const extractor = createUieRuleFallbackExtractor({
      uie: { extract: async () => { throw new Error('deliberate UIE outage') } },
      onGraphExtraction: (_turn, run) => { extractions.append(run) },
    })
    const text = '样品S7存放在恒温箱B2。'
    captures.register({ userMessage: text, assistantMessage: '', metadata: { sourceMessageIds: ['real-rule'] } }, scope, 'rule')
    await extractor({ userMessage: text, assistantMessage: '', metadata: { sourceMessageIds: ['real-rule'] } })
    const v4 = createMemoryV4Repository(), l1 = createGraphL1Store(disk())
    const semanticDisk = disk()
    const semantic = createGraphSemanticRepository(semanticDisk, v4, captures, extractions)
    expect((await semantic.syncFromClaims(l1, v4, createGraphPredicateRegistry(), scope)).ok).toBe(true)
    const reopened = createGraphSemanticRepository(semanticDisk, v4, captures, extractions)
    expect(searchOpenAssertions(reopened.snapshot()!, '样品S7', { scope })).toHaveLength(1)
    expect(v4.snapshot().facts).toHaveLength(0)
    expect(l1.claims()).toHaveLength(0)
  })
})
