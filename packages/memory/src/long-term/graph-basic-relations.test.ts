import { describe, expect, it } from 'vitest'
import { createBasicGraphRelationRegistry } from './graph-basic-relations'
import { createGraphExtractionRun, type FactContext, type GraphExtractionRun } from './graph-extraction-result'
import { autoNormalizeUieGraphFact } from './graph-auto-identity'
import { assessGraphClaim, createGraphL1Store, createGraphL1Writer, rejectGraphClaim } from './graph-l1-write'
import { createMemoryV4Repository } from '../v4/repository/memory-v4-repository'
import { createGraphSemanticRepository, exactClaimAvailable } from '../graph-core/repository/semantic-repository'
import { createGraphL1ProjectionRepository } from '../graph-core/repository/l1-projection-repository'
import { createV4GraphMemory, selectRetrievableGraphBundle, V4_GRAPH_BUDGET } from '../graph-core/adapters/v4-graph-memory'
import { createMemoryV4LifecycleService } from '../v4/lifecycle/memory-v4-lifecycle'
import { createOpenGraphExtractor } from './smart-memory-extractor'
import { needsOpenFactRepresentation } from '../graph-core/repository/open-assertions'

const scope = { ownerId: 'owner', agentId: 'agent' }
const now = 1_800_000_000_000
function storage() {
  let payload: string | undefined
  return { load: () => payload, save: (value: string) => { payload = value } }
}
function fixture(options: { text?: string; participants?: [string, string, string][]; relation?: string;
  context?: FactContext; score?: number } = {}): GraphExtractionRun {
  const text = options.text ?? '样品S7暂存于恒温箱B2。'
  const relation = options.relation ?? '暂存于'
  const participants = options.participants ?? [['样品S7', '样品', 'subject'], ['恒温箱B2', '设备', 'object']]
  const entities = participants.map(([name, type], i) => ({ id: `p${i}`, type, text: name,
    span: { start: text.indexOf(name), end: text.indexOf(name) + name.length }, modelScore: options.score ?? 0.5 }))
  return createGraphExtractionRun({ sourceId: 'source-1', sourceText: text, modelId: 'open-api', requireRelationSpan: true,
    rawOutput: { graph: { entities, facts: [], assertions: [{ id: 'a1', relationText: relation,
      relationSpan: { start: text.indexOf(relation), end: text.indexOf(relation) + relation.length },
      participants: participants.map(([, , role], i) => ({ mentionId: `p${i}`, role })),
      evidenceSpan: { start: 0, end: text.length }, modelScore: options.score ?? 0.5,
      context: options.context ?? { negation: { value: false, resolution: 'resolved' },
        speaker: { value: 'user', resolution: 'resolved' }, condition: { value: null, resolution: 'absent' },
        time: { value: null, resolution: 'absent' } },
    }] } } })
}

function pipeline() {
  const relationStorage = storage(), v4Storage = storage(), l1Storage = storage(), semanticStorage = storage(), viewStorage = storage()
  const registry = createBasicGraphRelationRegistry(relationStorage, scope)
  const v4 = createMemoryV4Repository({ persistence: v4Storage, now: () => now })
  const l1 = createGraphL1Store(l1Storage)
  const semantic = createGraphSemanticRepository(semanticStorage, v4)
  const projection = createGraphL1ProjectionRepository(viewStorage, semantic, v4, l1)
  const writer = createGraphL1Writer(v4, l1, registry, scope, { syncFromClaims: async () => {
    const result = await semantic.syncFromClaims(l1, v4, registry, scope)
    if (!result.ok || !projection.sync()) throw new Error('L1 projection failed')
  } })
  async function publish(raw: GraphExtractionRun) {
    const run = registry.prepare(raw)
    const candidate = run.factCandidates[0]!
    const automatic = autoNormalizeUieGraphFact(run, candidate.id, { entities: [], aliases: [], scope, registry })!
    const fact = automatic.normalized.facts[0]!
    const review = assessGraphClaim(run, fact, { sensitivity: 'normal', sharePolicy: 'allow-remote' }, now)
    const task = await writer.submit(run, fact, review, automatic.entities)
    return { run, fact, automatic, review, task }
  }
  return { registry, v4, l1, semantic, projection, writer, publish,
    relationStorage, v4Storage, l1Storage, semanticStorage, viewStorage }
}

describe('basic unknown relation publication into authoritative L1', () => {
  it('keeps reviewed basic facts publishable when re-extraction changes an observed entity type', () => {
    const registry = createBasicGraphRelationRegistry(storage(), scope)
    const first = registry.prepare(fixture())
    const original = autoNormalizeUieGraphFact(first, first.factCandidates[0]!.id,
      { entities: [], aliases: [], scope, registry })!
    const previousEntities = JSON.stringify(original.entities)
    const second = registry.prepare(fixture({ participants: [['样品S7', '样品', 'subject'], ['恒温箱B2', 'device', 'object']] }))
    expect(needsOpenFactRepresentation(second, second.factCandidates[0]!, registry)).toBe(false)
    const retried = autoNormalizeUieGraphFact(second, second.factCandidates[0]!.id,
      { entities: original.entities, aliases: [], scope, registry })!
    expect(retried.normalized.facts[0]?.status).toBe('ready')
    expect(JSON.stringify(original.entities)).toBe(previousEntities)
    expect(retried.entities.filter(e => e.canonicalName === '恒温箱B2').map(e => e.entityType)).toContain('device')
  })
  it('publishes a single-participant source event without creating a second semantic argument', async () => {
    const p = pipeline(), text = '插座P3坏了。'
    const raw = createGraphExtractionRun({ sourceId: 'unary', sourceText: text, modelId: 'test', requireRelationSpan: true,
      rawOutput: { graph: { entities: [{ id: 'plug', type: '设备', text: '插座P3', span: { start: 0, end: 4 }, modelScore: 0.8 }],
        facts: [], assertions: [{ id: 'broken', relationText: '坏了', relationSpan: { start: 4, end: 6 },
          participants: [{ mentionId: 'plug', role: 'subject' }], evidenceSpan: { start: 0, end: text.length }, modelScore: 0.8,
          context: fixture().assertionCandidates![0]!.context }] } } })
    expect((await p.publish(raw)).task?.state).toBe('published')
    expect(Object.keys(p.l1.claims()[0]!.atom.args)).toEqual(['subject'])
    expect(p.registry.definitions()[0]!.registration.spec.valueRole).toBeNull()
    expect(p.projection.snapshot()?.edges.filter(e => e.kind === 'has-argument')).toHaveLength(1)
    expect(p.l1.edges()).toHaveLength(0)
  })
  it('retains explicit planned modality and original time wording', async () => {
    const p = pipeline(), raw = fixture()
    raw.assertionCandidates![0]!.context.modality = { value: 'planned', resolution: 'resolved' }
    raw.assertionCandidates![0]!.context.time = { value: '下周', resolution: 'unresolved' }
    await p.publish(raw)
    expect(p.l1.claims()[0]!.modality).toBe('planned')
    expect(p.v4.snapshot().facts[0]!.sourceStatement?.qualifiers?.modality).toEqual({ value: 'planned', resolution: 'resolved' })
  })
  it('publishes an API assertion as a V4 Fact, exact Claim and ready projection while preserving raw extraction', async () => {
    const p = pipeline(), raw = fixture({ score: 0.2 }), before = JSON.stringify(raw)
    expect((await p.publish(raw)).task?.state).toBe('published')
    expect(JSON.stringify(raw)).toBe(before)
    expect(raw.factCandidates).toHaveLength(0)
    expect(p.l1.claims()).toHaveLength(1)
    expect(p.v4.snapshot().facts).toHaveLength(1)
    expect(p.v4.snapshot().facts[0]).toMatchObject({ canonicalText: raw.sourceText, extractionScore: 0.2,
      sourceStatement: { relationText: '暂存于', predicateVersion: 1 }, userConfirmed: false,
      metadata: { verificationMeaning: 'source-alignment-not-world-truth' } })
    expect(p.projection.snapshot()?.edges.filter(e => e.kind === 'has-argument')).toHaveLength(2)
    expect(p.semantic.snapshot()?.predicates[0]).toMatchObject({ registrationKind: 'basic', relationText: '暂存于',
      inferenceAllowed: false, transitivity: 'none' })
    expect(exactClaimAvailable(p.semantic.snapshot()!.claims[0]!, p.v4.snapshot())).toBe(true)
  })

  it('is available to formal direct graph recall, not only the open-source navigation route', async () => {
    const p = pipeline()
    await p.publish(fixture())
    const graph = createV4GraphMemory({ repository: p.v4, persistence: storage(), authorizeScope: () => true,
      canRead: () => true, countTokens: text => text.length, now: () => now,
      acceptedBundle: () => selectRetrievableGraphBundle(p.semantic.snapshot(), p.l1.tasks()) })
    const result = await graph.recall({ protocolVersion: 'memory-graph/v1', recallId: 'basic-recall',
      query: '样品S7', scope, temporal: { knownAt: now, valid: { kind: 'at', at: now } },
      mode: 'direct-only', budget: { ...V4_GRAPH_BUDGET }, sharePolicies: ['allow-remote'], sensitivities: ['normal'] })
    expect(result).toMatchObject({ ok: true, value: { evidence: { claims: [
      { content: '样品S7暂存于恒温箱B2。', ref: p.l1.claims()[0]!.ref },
    ] } } })
  })

  it('preserves every role in a three-participant event and refuses a tampered third argument', async () => {
    const p = pipeline(), raw = fixture({ text: '张三将样品S7移交给李四。', relation: '移交给',
      participants: [['张三', 'person', 'agent'], ['样品S7', '样品', 'object'], ['李四', 'person', 'recipient']] })
    expect((await p.publish(raw)).task?.state).toBe('published')
    const claim = p.semantic.snapshot()!.claims[0]!
    expect(Object.keys(claim.atom.args)).toEqual(['agent', 'object', 'recipient'])
    expect(p.v4.snapshot().factVersions[0]!.sourceStatement?.arguments).toEqual(claim.atom.args)
    expect(p.projection.snapshot()?.edges.filter(e => e.kind === 'has-argument')).toHaveLength(3)
    expect(p.l1.edges()).toHaveLength(0)
    const tampered = { ...structuredClone(claim), atom: { ...claim.atom,
      args: { ...claim.atom.args, recipient: claim.atom.args.agent! } } }
    expect(exactClaimAvailable(tampered, p.v4.snapshot())).toBe(false)
  })

  it('restores definitions, all participants and the formal view after restart without duplicate publication', async () => {
    const p = pipeline(), item = await p.publish(fixture())
    await p.publish(item.run)
    expect(p.registry.definitions()).toHaveLength(1)
    expect(p.v4.snapshot().facts).toHaveLength(1)
    const registry = createBasicGraphRelationRegistry(p.relationStorage, scope)
    const v4 = createMemoryV4Repository({ persistence: p.v4Storage, now: () => now })
    const l1 = createGraphL1Store(p.l1Storage)
    const semantic = createGraphSemanticRepository(p.semanticStorage, v4)
    expect((await semantic.syncFromClaims(l1, v4, registry, scope)).ok).toBe(true)
    const projection = createGraphL1ProjectionRepository(p.viewStorage, semantic, v4, l1)
    expect(projection.snapshot()?.semanticBundle.claims).toHaveLength(1)
    expect(registry.prepare(fixture()).factCandidates[0]!.predicate).toBe(item.fact.predicate)
  })

  it('does not register ambiguous roles, local pronouns, missing relation spans or incomplete extraction', () => {
    const registry = createBasicGraphRelationRegistry(storage(), scope)
    const unknownRole = fixture({ participants: [['样品S7', '样品', 'unknown'], ['恒温箱B2', '设备', 'object']] })
    const pronoun = fixture({ text: '他暂存于恒温箱B2。', participants: [['他', 'person', 'subject'], ['恒温箱B2', '设备', 'object']] })
    const missing = fixture(); delete missing.assertionCandidates![0]!.relationSpan
    const incomplete = fixture(); incomplete.status = 'incomplete'
    for (const run of [unknownRole, pronoun, missing, incomplete]) expect(registry.prepare(run).factCandidates).toHaveLength(0)
    expect(registry.definitions()).toHaveLength(0)
  })

  it('uses deterministic role signatures and does not merge different role meanings or identities by name', async () => {
    const p = pipeline(), raw = fixture()
    const first = await p.publish(raw)
    const reordered = fixture(); reordered.sourceId = 'source-2'; reordered.assertionCandidates![0]!.participants.reverse()
    const prepared = p.registry.prepare(reordered)
    expect(prepared.factCandidates[0]!.predicate).toBe(first.fact.predicate)
    const second = await p.publish(reordered)
    expect(p.registry.definitions()).toHaveLength(1)
    expect(second.fact.arguments).not.toEqual(first.fact.arguments)
    const different = fixture({ participants: [['样品S7', '样品', 'sample'], ['恒温箱B2', '设备', 'container']] })
    expect(p.registry.prepare(different).factCandidates[0]!.predicate).not.toBe(first.fact.predicate)
  })

  it('preserves negative and conditional context without claiming a current positive fact', async () => {
    const p = pipeline(), raw = fixture({ text: '如果检测失败，样品S7不暂存于恒温箱B2。', context: {
      negation: { value: true, resolution: 'resolved' }, condition: { value: '如果检测失败', resolution: 'resolved' },
      time: { value: null, resolution: 'unresolved' }, speaker: { value: 'user', resolution: 'resolved' },
    } })
    await p.publish(raw)
    expect(p.l1.claims()[0]).toMatchObject({ polarity: 'negative', modality: 'hypothetical', validTime: { kind: 'unknown' },
      condition: { text: '如果检测失败' } })
  })

  it('cannot override a user rejection during repeated policy publication', async () => {
    const p = pipeline(), run = p.registry.prepare(fixture())
    const automatic = autoNormalizeUieGraphFact(run, 'a1', { entities: [], aliases: [], scope, registry: p.registry })!
    const fact = automatic.normalized.facts[0]!
    const review = assessGraphClaim(run, fact, { sensitivity: 'normal', sharePolicy: 'allow-remote' }, now)
    p.l1.recordReview(rejectGraphClaim(review, 'Do not use', now))
    expect(await p.writer.submit(run, fact, review, automatic.entities)).toBeUndefined()
    expect(p.l1.claims()).toHaveLength(0)
  })

  it('recovers a failed semantic publication without duplicating the Fact or relation', async () => {
    const p = pipeline(), raw = fixture(), run = p.registry.prepare(raw)
    const automatic = autoNormalizeUieGraphFact(run, 'a1', { entities: [], aliases: [], scope, registry: p.registry })!
    const fact = automatic.normalized.facts[0]!
    const review = assessGraphClaim(run, fact, { sensitivity: 'normal', sharePolicy: 'allow-remote' }, now)
    let fail = true
    const writer = createGraphL1Writer(p.v4, p.l1, p.registry, scope, { syncFromClaims: async () => {
      if (fail) { fail = false; throw new Error('disk failure') }
      await p.semantic.syncFromClaims(p.l1, p.v4, p.registry, scope)
      p.projection.sync()
    } })
    expect((await writer.submit(run, fact, review, automatic.entities))?.state).toBe('fact-persisted')
    await writer.retryPending()
    expect(p.l1.tasks()[0]?.state).toBe('published')
    expect(p.v4.snapshot().facts).toHaveLength(1)
    expect(p.registry.definitions()).toHaveLength(1)
  })

  it('removes complete statement payloads and historical argument values during irreversible purge', async () => {
    const p = pipeline()
    await p.publish(fixture())
    const id = p.v4.snapshot().facts[0]!.id
    createMemoryV4LifecycleService(p.v4, { now: () => now + 1 }).deleteFact(id, scope, 'purge',
      { reason: 'remove', idempotencyKey: 'purge-basic' })
    expect(p.v4.snapshot().facts[0]!.sourceStatement).toBeUndefined()
    expect(p.v4.snapshot().factVersions.every(v => !v.sourceStatement)).toBe(true)
    expect(exactClaimAvailable(p.l1.claims()[0]!, p.v4.snapshot())).toBe(false)
  })

  it('connects the actual open API extractor to formal publication', async () => {
    const p = pipeline(), raw = fixture()
    const extractor = createOpenGraphExtractor({ getConfig: () => ({ apiKey: 'test', model: 'test-model', baseURL: 'http://unused' }),
      complete: async () => JSON.stringify(raw.rawOutput), saveGraphExtraction: async run => { await p.publish(run) } })
    await extractor({ userMessage: raw.sourceText, assistantMessage: '', metadata: { sourceMessageIds: ['api-source'] } })
    expect(p.l1.claims()).toHaveLength(1)
    expect(p.v4.snapshot().facts[0]!.sourceStatement?.relationText).toBe('暂存于')
  })

  it('publishes an unregistered literal-valued fact without inventing an entity object', async () => {
    const p = pipeline(), text = '温度计T1读数为23。', raw = fixture()
    const run = createGraphExtractionRun({ sourceId: 'literal-source', sourceText: text, modelId: 'test', rawOutput: {
      graph: { entities: [{ id: 't', type: 'unknown', text: '温度计T1', span: { start: 0, end: 5 }, modelScore: 0.3 }],
        facts: [{ id: 'f', subjectMentionId: 't', predicate: '读数为', object: { literal: '23', valueType: 'number' },
          evidenceSpan: { start: 0, end: text.length }, modelScore: 0.3, context: raw.assertionCandidates![0]!.context }] },
    } })
    expect((await p.publish(run)).task?.state).toBe('published')
    expect(p.v4.snapshot().facts[0]).toMatchObject({ object: 23, objectType: 'number',
      sourceStatement: { relationText: '读数为', arguments: { value: { kind: 'number', value: 23 } } } })
    expect(p.l1.claims()[0]!.atom.args.value).toEqual({ kind: 'number', value: 23 })
  })

  it('rejects a derived assertion whose participant binding differs from the retained model output', () => {
    const registry = createBasicGraphRelationRegistry(storage(), scope)
    const run = registry.prepare(fixture({ text: '张三将样品S7移交给李四。', relation: '移交给',
      participants: [['张三', 'person', 'agent'], ['样品S7', '样品', 'object'], ['李四', 'person', 'recipient']] }))
    run.factCandidates[0]!.participants![2]!.mentionId = 'p0'
    expect(autoNormalizeUieGraphFact(run, 'a1', { entities: [], aliases: [], scope, registry })).toBeUndefined()
  })
})
