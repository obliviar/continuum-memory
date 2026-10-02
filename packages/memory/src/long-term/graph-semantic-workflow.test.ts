import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { createGraphSemanticWorkflow } from './graph-semantic-workflow'
import { createBasicGraphRelationRegistry } from './graph-basic-relations'
import { createGraphExtractionRun } from './graph-extraction-result'
import { autoNormalizeUieGraphFact } from './graph-auto-identity'
import { assessGraphClaim, createGraphL1Store, createGraphL1Writer } from './graph-l1-write'
import { createMemoryV4Repository } from '../v4/repository/memory-v4-repository'
import { createGraphSemanticRepository, exactClaimAvailable } from '../graph-core/repository/semantic-repository'

const scope = { ownerId: 'o', agentId: 'a' }
const config = { apiKey: 'test', model: 'test' }
const storage = () => { let payload: string | undefined; return { load: () => payload, save: (next: string) => { payload = next } } }
function run(relation = '存放于') {
  const text = `样品S7${relation}恒温箱B2。`
  return createGraphExtractionRun({ sourceId: 'source', sourceText: text, modelId: 'test', requireRelationSpan: true,
    rawOutput: { graph: { entities: [
      { id: 's', type: '样品', text: '样品S7', span: { start: 0, end: 4 }, modelScore: 0.8 },
      { id: 'b', type: '设备', text: '恒温箱B2', span: { start: 4 + relation.length, end: 9 + relation.length }, modelScore: 0.8 },
    ], facts: [], assertions: [{ id: 'r', relationText: relation, relationSpan: { start: 4, end: 4 + relation.length },
      participants: [{ mentionId: 's', role: 'subject' }, { mentionId: 'b', role: 'object' }],
      evidenceSpan: { start: 0, end: text.length }, modelScore: 0.8,
      context: { negation: { value: false, resolution: 'resolved' }, speaker: { value: 'user', resolution: 'resolved' },
        condition: { value: null, resolution: 'absent' }, time: { value: null, resolution: 'absent' } } }] } } })
}
const supported = (relation?: unknown) => JSON.stringify({ decisions: [{ candidateId: 'r', verdict: 'supported',
  definition: '某对象被存放在某容器中', reason: '原文表达明确', ...(relation ? { relation } : {}) }] })

describe('API semantic review, mappings and explicit clarification', () => {
  it('locally republishes a legacy reviewed plan with a source-backed calendar month', async () => {
    const text = '他下个月接手项目。', extra = '他指孟川，项目是项目丁，时间为2026年11月。'
    const input = createGraphExtractionRun({ sourceId: 'legacy-plan', sourceText: text, modelId: config.model,
      requireRelationSpan: true, rawOutput: { graph: {
        entities: [
          { id: 'person', type: 'Person', text: '他', resolvedText: '孟川', span: { start: 0, end: 1 }, modelScore: 0.9 },
          { id: 'when', type: 'Time', text: '下个月', resolvedText: '2026年11月', span: { start: 1, end: 4 }, modelScore: 0.9 },
          { id: 'project', type: 'Project', text: '项目', resolvedText: '项目丁', span: { start: 6, end: 8 }, modelScore: 0.9 },
        ], facts: [], assertions: [{ id: 'r', relationText: '接手', relationSpan: { start: 4, end: 6 },
          participants: [{ mentionId: 'person', role: 'agent' }, { mentionId: 'project', role: 'object' }],
          evidenceSpan: { start: 0, end: 8 }, modelScore: 0.9,
          context: { negation: false, condition: null, time: '下个月', speaker: null, modality: 'planned' },
        }] } } })
    input.supplementalEvidence = [{ sourceId: 'clarification', text: extra,
      sourceRevision: createHash('sha256').update(extra).digest('hex') }]
    const registry = createBasicGraphRelationRegistry(storage(), scope), saved = storage()
    const settings = { persistence: saved, registry, getConfig: () => config, canUse: () => true,
      complete: async () => { throw new Error('Repair must use the retained review') } }
    // This is a persisted v2 decision from before scalar qualifiers were parsed.
    saved.save(JSON.stringify({ version: 1, items: [{ id: 'review', run: { ...input,
      assertionCandidates: input.assertionCandidates!.map(a => ({ ...a, context: {
        ...a.context, modality: { value: null, resolution: 'unresolved' } } })) },
      status: 'ready', attempts: 1, fingerprint: 'old-input',
      configFingerprint: createHash('sha256').update(JSON.stringify(['source-semantics-v2', config.model, undefined])).digest('hex'),
      decisions: [{ candidateId: 'r', verdict: 'supported', definition: '某人接手某项目', reason: '原文与补充证据一致' }],
      updatedAt: 1 }] }))
    const workflow = createGraphSemanticWorkflow(settings)
    const recovered = (await workflow.retry(5, true, [input.id]))[0]!
    expect(recovered.id).not.toBe(input.id)
    expect(recovered.semanticReview?.contextVersion).toBe('scalar-qualifiers-v1')
    expect(recovered.factCandidates[0]!.context).toMatchObject({ modality: { value: 'planned' },
      time: { value: '2026年11月' } })
    expect(workflow.isReviewed(recovered)).toBe(true)
    const resolved = autoNormalizeUieGraphFact(recovered, 'r', { entities: [], aliases: [], scope, registry })!
    const fact = resolved.normalized.facts[0]!, v4 = createMemoryV4Repository(), l1 = createGraphL1Store(storage())
    const writer = createGraphL1Writer(v4, l1, registry, scope)
    const review = assessGraphClaim(recovered, fact, { sensitivity: 'normal', sharePolicy: 'allow-remote' })
    expect((await writer.submit(recovered, fact, review, resolved.entities))?.state).toBe('published')
    expect(l1.claims()[0]).toMatchObject({ modality: 'planned', temporalSource: { value: '2026年11月' },
      validTime: { kind: 'interval', from: Date.UTC(2026, 10, 1), to: Date.UTC(2026, 11, 1) } })
    expect(l1.claims()[0]!.provenance.sources).toHaveLength(2)
  })
  it('validates publication views locally and rejects a tampered qualifier without another API call', async () => {
    const registry = createBasicGraphRelationRegistry(storage(), scope)
    let calls = 0
    const workflow = createGraphSemanticWorkflow({ persistence: storage(), registry, getConfig: () => config,
      canUse: () => true, complete: async () => { calls++; return supported() } })
    const result = (await workflow.process(run()))!
    expect(workflow.isReviewed(result)).toBe(true)
    const altered = structuredClone(result)
    altered.factCandidates[0]!.context.negation.value = true
    expect(workflow.isReviewed(altered)).toBe(false)
    expect(calls).toBe(1)
  })
  it('recovers legacy scalar plan qualifiers and source-backed time resolution without rewriting raw extraction', async () => {
    const text = '他下个月接手项目。', extra = '他指孟川，时间为2026年11月。'
    const original = createGraphExtractionRun({ sourceId: 'scalar', sourceText: text, modelId: 'test', rawOutput: { graph: {
      entities: [{ id: 'p', type: 'Person', text: '他', resolvedText: '孟川', span: { start: 0, end: 1 }, modelScore: 0.9 },
        { id: 't', type: 'Time', text: '下个月', resolvedText: '2026年11月', span: { start: 1, end: 4 }, modelScore: 0.9 },
        { id: 'o', type: 'Project', text: '项目', span: { start: 6, end: 8 }, modelScore: 0.9 }], facts: [],
      assertions: [{ id: 'r', relationText: '接手', relationSpan: { start: 4, end: 6 },
        participants: [{ mentionId: 'p', role: 'agent' }, { mentionId: 'o', role: 'object' }],
        evidenceSpan: { start: 0, end: 8 }, modelScore: 0.9,
        context: { negation: false, condition: null, time: '下个月', speaker: null, modality: 'planned' } }] } } })
    original.supplementalEvidence = [{ sourceId: 'extra', text: extra, sourceRevision: createHash('sha256').update(extra).digest('hex') }]
    original.assertionCandidates![0]!.context.modality = { value: null, resolution: 'unresolved' }
    const raw = JSON.stringify(original.rawOutput)
    const registry = createBasicGraphRelationRegistry(storage(), scope)
    const workflow = createGraphSemanticWorkflow({ persistence: storage(), registry, getConfig: () => config,
      canUse: () => true, complete: async () => supported() })
    const view = (await workflow.process(original))!
    expect(view.factCandidates[0]!.context).toMatchObject({ negation: { value: false, resolution: 'resolved' },
      modality: { value: 'planned', resolution: 'resolved' }, time: { value: '2026年11月', resolution: 'resolved' } })
    expect(autoNormalizeUieGraphFact(view, 'r', { entities: [], aliases: [], scope, registry })?.normalized.facts[0]?.status).toBe('ready')
    expect(JSON.stringify(workflow.list()[0]!.run.rawOutput)).toBe(raw)
  })
  it('derives publication state from live Claims and reissues a missing publication without another API call', async () => {
    let calls = 0
    const registry = createBasicGraphRelationRegistry(storage(), scope)
    const workflow = createGraphSemanticWorkflow({ persistence: storage(), registry, getConfig: () => config,
      canUse: () => true, complete: async () => { calls++; return supported() } })
    const result = (await workflow.process(run()))!
    workflow.reconcilePublication([{ runId: result.id, claimId: 'claim' }])
    expect(workflow.list()[0]?.status).toBe('published')
    workflow.reconcilePublication([])
    expect(workflow.list()[0]?.status).toBe('ready')
    const retried = (await workflow.retry(5, true))[0]!
    expect(retried.id).not.toBe(result.id)
    expect(retried.semanticReview?.candidateIds).toEqual(['r'])
    expect(calls).toBe(1)
  })
  it('uses a new publication identity when a ready item is retried under a changed model', async () => {
    let model = 'first'
    const registry = createBasicGraphRelationRegistry(storage(), scope)
    const workflow = createGraphSemanticWorkflow({ persistence: storage(), registry,
      getConfig: () => ({ ...config, model }), canUse: () => true, complete: async () => supported() })
    const original = (await workflow.process(run()))!
    model = 'second'
    expect(await workflow.retry(5, true)).toEqual([])
    const retried = (await workflow.retry())[0]!
    expect(retried.id).not.toBe(original.id)
    expect(workflow.list()[0]?.run.id).toBe(retried.id)
  })
  it('uses intact prior user context to resolve a source-local reference before asking', async () => {
    const registry = createBasicGraphRelationRegistry(storage(), scope)
    const original = run(), graph = (original.rawOutput as { graph: any }).graph
    const text = '他存放于恒温箱B2。'
    graph.entities[0] = { ...graph.entities[0], text: '他', type: 'person', span: { start: 0, end: 1 } }
    graph.entities[1].span = { start: 4, end: 9 }
    graph.assertions[0].relationSpan = { start: 1, end: 4 }
    graph.assertions[0].evidenceSpan = { start: 0, end: text.length }
    const input = createGraphExtractionRun({ sourceId: 'source', sourceText: text, modelId: 'test', rawOutput: { graph }, requireRelationSpan: true })
    const prior = '张三管理恒温箱B2。'
    const workflow = createGraphSemanticWorkflow({ persistence: storage(), registry, getConfig: () => config, canUse: () => true,
      lookupContext: () => [{ text: prior, sourceId: 'previous', sourceRevision: createHash('sha256').update(prior).digest('hex') }],
      complete: async () => JSON.stringify({ decisions: [{ candidateId: 'r', verdict: 'supported', definition: '存放关系',
        reason: '前文已说明人物', resolvedMentions: { s: '张三' } }] }) })
    const result = (await workflow.process(input))!
    expect(result.entityMentions[0]!.text).toBe('他')
    expect(result.entityMentions[0]!.resolvedText).toBe('张三')
    expect(result.supplementalEvidence?.[0]!.text).toBe(prior)
    expect(workflow.list()[0]!.status).toBe('ready')
    expect(autoNormalizeUieGraphFact(result, 'r', { entities: [], aliases: [], scope, registry })?.entities[0]!.canonicalName).toBe('张三')
  })
  it('does not reuse another model configuration’s cached review', async () => {
    let model = 'first', calls = 0
    const registry = createBasicGraphRelationRegistry(storage(), scope), input = run()
    const workflow = createGraphSemanticWorkflow({ persistence: storage(), registry, getConfig: () => ({ ...config, model }),
      canUse: () => true, complete: async () => { calls++; return supported() } })
    await workflow.process(input); model = 'second'; await workflow.process(input)
    expect(calls).toBe(2)
  })
  it('keeps the same words in distinct senses when equivalence has not been established', async () => {
    const registry = createBasicGraphRelationRegistry(storage(), scope)
    let definition = '一种存放关系'
    const workflow = createGraphSemanticWorkflow({ persistence: storage(), registry, getConfig: () => config, canUse: () => true,
      complete: async () => JSON.stringify({ decisions: [{ candidateId: 'r', verdict: 'supported', definition, reason: '语境不同',
        relation: { kind: 'different', informationLoss: true } }] }) })
    const first = (await workflow.process(run()))!, second = run(); second.sourceId = 'another-source'
    definition = '另一种限定含义'
    const next = (await workflow.process(second))!
    expect(next.factCandidates[0]!.predicate).not.toBe(first.factCandidates[0]!.predicate)
    expect((await workflow.process(second))!.factCandidates[0]!.predicate).toBe(next.factCandidates[0]!.predicate)
  })
  it('reviews before publication and caches the same extraction without another API call', async () => {
    let calls = 0
    const registry = createBasicGraphRelationRegistry(storage(), scope)
    const workflow = createGraphSemanticWorkflow({ persistence: storage(), registry, getConfig: () => config,
      canUse: () => true, complete: async () => { calls++; return supported() } })
    const input = run(), raw = JSON.stringify(input)
    expect((await workflow.process(input))?.factCandidates).toHaveLength(1)
    expect(await workflow.process(input)).toBeDefined()
    expect(calls).toBe(1)
    expect(JSON.stringify(input)).toBe(raw)
    expect(registry.definitions()[0]!.definition).toBe('某对象被存放在某容器中')
  })

  it('merges a supported equivalent only with a complete type-compatible role map', async () => {
    const registry = createBasicGraphRelationRegistry(storage(), scope)
    const target = registry.prepare(run('存放在')).factCandidates[0]!.predicate
    const workflow = createGraphSemanticWorkflow({ persistence: storage(), registry, getConfig: () => config,
      canUse: () => true, complete: async () => supported({ kind: 'equivalent', targetPredicateId: target,
        roleMapping: { subject: 'subject', object: 'object' }, informationLoss: false }) })
    const result = await workflow.process(run())
    expect(result?.factCandidates[0]!.predicate).toBe(target)
    expect(registry.mappings()).toHaveLength(1)
    expect(autoNormalizeUieGraphFact(result!, 'r', { entities: [], aliases: [], scope, registry })?.normalized.facts[0]!.status).toBe('ready')
    registry.revokeMapping(registry.mappings()[0]!.id)
    expect(registry.prepare(run()).factCandidates[0]!.predicate).not.toBe(target)
  })

  it('does not merge merely related, lossy or incomplete role mappings', async () => {
    for (const relation of [
      { kind: 'related', roleMapping: { subject: 'subject', object: 'object' }, informationLoss: false },
      { kind: 'equivalent', roleMapping: { subject: 'subject', object: 'object' }, informationLoss: true },
      { kind: 'equivalent', roleMapping: { subject: 'subject' }, informationLoss: false },
    ]) {
      const registry = createBasicGraphRelationRegistry(storage(), scope)
      const target = registry.prepare(run('存放在')).factCandidates[0]!.predicate
      const workflow = createGraphSemanticWorkflow({ persistence: storage(), registry, getConfig: () => config,
        canUse: () => true, complete: async () => supported({ ...relation, targetPredicateId: target }) })
      expect((await workflow.process(run()))?.factCandidates[0]!.predicate).not.toBe(target)
      expect(registry.mappings()).toHaveLength(0)
    }
  })

  it('holds ambiguous candidates and requires a matching question ID and source revision', async () => {
    const registry = createBasicGraphRelationRegistry(storage(), scope)
    const workflow = createGraphSemanticWorkflow({ persistence: storage(), registry, getConfig: () => config,
      canUse: () => true, complete: async () => JSON.stringify({ decisions: [{ candidateId: 'r', verdict: 'needs-context',
        definition: '', reason: '需要确认是否临时', question: '这里是临时存放还是长期存放？' }] }) })
    expect((await workflow.process(run()))?.factCandidates).toHaveLength(0)
    expect(registry.definitions()).toHaveLength(0)
    const item = workflow.list()[0]!
    await expect(workflow.answer(item.id, 'r', 'wrong-revision', '临时')).rejects.toThrow('stale-clarification')
    expect(workflow.list()[0]!.status).toBe('waiting')
    workflow.dismiss(item.id, 'r')
    expect(workflow.list()[0]!.status).toBe('dismissed')
  })

  it('keeps clarification as a separate evidence source through real Fact and Claim persistence', async () => {
    const registry = createBasicGraphRelationRegistry(storage(), scope)
    let call = 0
    const workflow = createGraphSemanticWorkflow({ persistence: storage(), registry, getConfig: () => config,
      canUse: () => true, complete: async () => {
        if (++call === 1) return JSON.stringify({ decisions: [{ candidateId: 'r', verdict: 'needs-context', definition: '',
          reason: '缺少信息', question: '是否临时存放？' }] })
        if (call === 2) return JSON.stringify(run().rawOutput)
        return supported()
      } })
    const original = run()
    await workflow.process(original)
    const item = workflow.list()[0]!
    const prepared = (await workflow.answer(item.id, 'r', original.sourceRevision, '这是临时存放。'))!
    expect(prepared.sourceText).toBe(original.sourceText)
    expect(prepared.supplementalEvidence).toHaveLength(1)
    const v4 = createMemoryV4Repository(), l1 = createGraphL1Store(storage())
    const semantic = createGraphSemanticRepository(storage(), v4)
    const writer = createGraphL1Writer(v4, l1, registry, scope, { syncFromClaims: async () => {
      const result = await semantic.syncFromClaims(l1, v4, registry, scope); if (!result.ok) throw new Error(result.error.message)
    } })
    const normalized = autoNormalizeUieGraphFact(prepared, 'r', { entities: [], aliases: [], scope, registry })!
    const fact = normalized.normalized.facts[0]!
    const review = assessGraphClaim(prepared, fact, { sensitivity: 'normal', sharePolicy: 'allow-remote' })
    expect((await writer.submit(prepared, fact, review, normalized.entities))?.state).toBe('published')
    expect(l1.claims()[0]!.provenance.sources).toHaveLength(2)
    expect(v4.snapshot().episodes.map(e => e.content)).toContain('这是临时存放。')
    expect(v4.snapshot().facts[0]!.canonicalText).toBe(original.sourceText)
    expect(exactClaimAvailable(semantic.snapshot()!.claims[0]!, v4.snapshot())).toBe(true)
  })

  it('scrubs cancelled sources and ignores a late API result', async () => {
    const registry = createBasicGraphRelationRegistry(storage(), scope)
    let release!: (text: string) => void
    const workflow = createGraphSemanticWorkflow({ persistence: storage(), registry, getConfig: () => config,
      canUse: () => true, complete: () => new Promise(resolve => { release = resolve }) })
    const pending = workflow.process(run())
    workflow.removeSources(['source'])
    release(supported())
    expect(await pending).toBeUndefined()
    expect(JSON.stringify(workflow.list())).not.toContain('样品S7')
    expect(registry.definitions()).toHaveLength(0)
  })

  it('limits failures to three attempts across restart and never publishes invalid semantic output', async () => {
    const registry = createBasicGraphRelationRegistry(storage(), scope), persistence = storage()
    const settings = { persistence, registry, getConfig: () => config, canUse: () => true, complete: async () => 'invalid' }
    const workflow = createGraphSemanticWorkflow(settings)
    expect(await workflow.process(run())).toBeUndefined()
    await workflow.retry()
    const restarted = createGraphSemanticWorkflow(settings)
    await restarted.retry(); await restarted.retry()
    expect(restarted.list()[0]!.attempts).toBe(3)
    expect(registry.definitions()).toHaveLength(0)
  })
})
