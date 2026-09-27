import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createMemoryV4Repository } from '../v4/repository/memory-v4-repository'
import { createGraphExtractionRun, type FactContext } from './graph-extraction-result'
import { createGraphPredicateRegistry, normalizeGraphExtraction, type GraphEntityRecord } from './graph-identity-normalization'
import { assessGraphClaim, confirmGraphClaim, rejectGraphClaim, deferGraphClaim,
  setGraphUseAssessment, createGraphL1Store, createGraphL1Writer } from './graph-l1-write'
import { createGraphSemanticRepository } from '../graph-core/repository/semantic-repository'
import { createGraphL1ProjectionRepository } from '../graph-core/repository/l1-projection-repository'
import { reviewGraphAdmission } from './graph-admission-review'
import { createV4GraphMemory, selectRetrievableGraphBundle, V4_GRAPH_BUDGET } from '../graph-core/adapters/v4-graph-memory'
import type { GraphRecallRequest } from '@continuum-memory/contracts'

const scope = { ownerId: 'owner', agentId: 'agent' }
const entities: GraphEntityRecord[] = [
  { ref: { kind: 'entity', id: 'person-alex', version: 3 }, scope, entityType: 'person', canonicalName: 'Alexander', aliases: ['Alex'] },
  { ref: { kind: 'entity', id: 'org-acme', version: 2 }, scope, entityType: 'organization', canonicalName: 'Acme Corporation', aliases: ['Acme'] },
]
const context: FactContext = {
  negation: { value: false, resolution: 'resolved' },
  condition: { value: null, resolution: 'absent' },
  time: { value: '2026-09-26', resolution: 'resolved' },
  speaker: { value: null, resolution: 'absent' },
}

function fixture(score = 0.91, sourceId = 'message-1', factContext: FactContext = context) {
  const sourceText = 'Alex works at Acme'
  const run = createGraphExtractionRun({ sourceId, sourceText, modelId: 'uie-test', rawOutput: {
    graph: {
      entities: [
        { id: 'person', type: 'person', text: 'Alex', span: { start: 0, end: 4 }, modelScore: score },
        { id: 'org', type: 'organization', text: 'Acme', span: { start: 14, end: 18 }, modelScore: score },
      ],
      facts: [{ id: 'fact-1', subjectMentionId: 'person', predicate: 'works at',
        object: { mentionId: 'org' }, evidenceSpan: { start: 0, end: 18 }, modelScore: score, context: factContext }],
    },
  } })
  const normalized = normalizeGraphExtraction(run, { entities, scope })
  return { run, fact: normalized.facts[0]! }
}

function memoryPersistence() {
  let payload: string | undefined
  return { load: () => payload, save: (next: string) => { payload = next } }
}

describe('reviewed graph L1 publication', () => {
  it('rejects an incomplete or imprecise admission decision before graph write', () => {
    const { run, fact } = fixture()
    expect(() => reviewGraphAdmission(run, fact.sourceFactId,
      { negation: 'positive', condition: 'none', time: '2026-02-30', speaker: 'self' }, {}))
      .toThrow('exact YYYY-MM-DD')
    run.status = 'incomplete'
    expect(() => reviewGraphAdmission(run, fact.sourceFactId,
      { negation: 'positive', condition: 'none', time: 'unknown', speaker: 'self' }, {}))
      .toThrow('complete extraction')
  })
  it('retries a failed stable-view save without duplicating the V4 Fact', async () => {
    const v4 = createMemoryV4Repository({ now: () => 1_800_000_000_000 })
    const l1 = createGraphL1Store(memoryPersistence())
    const registry = createGraphPredicateRegistry()
    const semantic = createGraphSemanticRepository(memoryPersistence(), v4)
    let failed = false
    const storage = memoryPersistence()
    const projection = createGraphL1ProjectionRepository({ load: storage.load, save(payload) {
      if (!failed) { failed = true; throw new Error('projection save failed') }
      storage.save(payload)
    } }, semantic, v4)
    const writer = createGraphL1Writer(v4, l1, registry, scope, { syncFromClaims: async () => {
      const result = await semantic.syncFromClaims(l1, v4, registry, scope)
      if (!result.ok || !projection.sync()) throw new Error('L1 view publication failed')
    } })
    const { run, fact } = fixture()
    const review = assessGraphClaim(run, fact, { sensitivity: 'normal', sharePolicy: 'allow-remote' }, 1_800_000_000_000)
    expect((await writer.submit(run, fact, review, entities))?.state).toBe('fact-persisted')
    expect(projection.snapshot()).toBeUndefined()
    await writer.retryPending()
    expect(l1.tasks()[0]?.state).toBe('published')
    expect(v4.snapshot().facts).toHaveLength(1)
    expect(projection.snapshot()?.semanticBundle.claims).toHaveLength(1)
  })
  it('publishes reviewed context and a stable Claim-to-Entity L1 view without altering raw extraction', async () => {
    const v4 = createMemoryV4Repository({ now: () => 1_800_000_000_000 })
    const l1 = createGraphL1Store(memoryPersistence())
    const registry = createGraphPredicateRegistry()
    const semantic = createGraphSemanticRepository(memoryPersistence(), v4)
    const storage = memoryPersistence()
    const projection = createGraphL1ProjectionRepository(storage, semantic, v4, l1)
    const rawContext: FactContext = { negation: { value: null, resolution: 'unresolved' },
      condition: { value: null, resolution: 'unresolved' }, time: { value: null, resolution: 'unresolved' },
      speaker: { value: null, resolution: 'unresolved' } }
    const { run, fact } = fixture(0.9, 'reviewed-source', rawContext)
    const review = confirmGraphClaim(assessGraphClaim(run, fact,
      { sensitivity: 'private', sharePolicy: 'local-only' }, 1_800_000_000_000), 'Checked original message', 1_800_000_000_000)
    const admission = reviewGraphAdmission(run, fact.sourceFactId, { negation: 'negative', condition: 'none',
      time: '2026-09-26', speaker: 'self' }, {})
    const writer = createGraphL1Writer(v4, l1, registry, scope, { syncFromClaims: async () => {
      const result = await semantic.syncFromClaims(l1, v4, registry, scope)
      if (!result.ok || !projection.sync()) throw new Error('L1 view publication failed')
    } })
    expect((await writer.submit(run, fact, review, entities, admission))?.state).toBe('published')
    expect(run.factCandidates[0]!.context).toEqual(rawContext)
    expect(l1.claims()[0]).toMatchObject({ polarity: 'negative', modality: 'asserted',
      validTime: { kind: 'interval' }, sensitivity: 'private' })
    expect(v4.snapshot().facts[0]).toMatchObject({ polarity: 'negative', modality: 'asserted' })
    const view = projection.snapshot()!
    expect(view.manifest).toMatchObject({ state: 'ready', sourceBundleId: semantic.snapshot()!.bundleId })
    expect(view.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'has-argument', role: 'person', from: l1.claims()[0]!.ref }),
      expect.objectContaining({ kind: 'has-argument', role: 'organization', from: l1.claims()[0]!.ref }),
    ]))
    expect(projection.sync()?.manifest.manifestId).toBe(view.manifest.manifestId)
    expect(createGraphL1ProjectionRepository(storage, semantic, v4, l1).snapshot()?.manifest.manifestId)
      .toBe(view.manifest.manifestId)
    storage.save(JSON.stringify({ ...view, edges: [] }))
    const tampered = createGraphL1ProjectionRepository(storage, semantic, v4, l1)
    expect(tampered.snapshot()).toBeUndefined()
    expect(tampered.sync()?.edges).toHaveLength(2)
    projection.invalidate()
    expect(createGraphL1ProjectionRepository(storage, semantic, v4, l1).snapshot()).toBeUndefined()
    expect(projection.sync()?.manifest.manifestId).toBe(view.manifest.manifestId)
    l1.removeSources(['reviewed-source'])
    expect(projection.snapshot()).toBeUndefined()
    const removed = await semantic.syncFromClaims(l1, v4, registry, scope)
    expect(removed.ok).toBe(true)
    expect(projection.snapshot()).toBeUndefined()
  })
  it('shares a normalized actual context across distinct sources and reconciles its provenance on removal', async () => {
    const v4 = createMemoryV4Repository({ now: () => 1_800_000_000_000 })
    const l1 = createGraphL1Store(memoryPersistence())
    const writer = createGraphL1Writer(v4, l1, createGraphPredicateRegistry(), scope)
    const first = fixture(0.91, 'message-1')
    const second = fixture(0.91, 'message-2')
    const approve = (item: ReturnType<typeof fixture>, sensitivity: 'normal' | 'private') =>
      assessGraphClaim(item.run, item.fact, { sensitivity, sharePolicy: sensitivity === 'private'
        ? 'local-only' : 'allow-remote' }, 1_800_000_000_000)
    expect((await writer.submit(first.run, first.fact, approve(first, 'normal'), entities))?.state).toBe('published')
    expect((await writer.submit(second.run, second.fact, approve(second, 'private'), entities))?.state).toBe('published')
    expect(l1.claims()).toHaveLength(2)
    expect(l1.claims()[0]!.context).toEqual(l1.claims()[1]!.context)
    expect(l1.contexts()).toHaveLength(1)
    expect(l1.contexts()[0]).toMatchObject({ scenario: 'actual', sensitivity: 'private',
      sharePolicy: 'local-only', frame: { speaker: { kind: 'self' }, condition: { kind: 'none' },
        isolation: 'shared' } })
    expect(l1.contexts()[0]!.provenance.sources).toHaveLength(2)
    l1.removeSources(['message-1'])
    expect(l1.claims()).toHaveLength(1)
    expect(l1.contexts()).toHaveLength(1)
    expect(l1.contexts()[0]!.provenance.sources).toHaveLength(1)
    expect(l1.contexts()[0]!.provenance.sources[0]!.contentHash).toBe(second.run.sourceRevision)
    l1.removeSources(['message-2'])
    expect(l1.contexts()).toHaveLength(0)
  })

  it('separates reported speakers, conditions, unresolved frames, and memory scopes', async () => {
    const l1 = createGraphL1Store(memoryPersistence())
    const v4 = createMemoryV4Repository({ now: () => 1_800_000_000_000 })
    const writer = createGraphL1Writer(v4, l1, createGraphPredicateRegistry(), scope)
    const speaker = (value: string) => ({ ...context, speaker: { value, resolution: 'resolved' as const } })
    const inputs = [fixture(0.91, 'speaker-a', speaker('Alice')),
      fixture(0.91, 'speaker-a-again', speaker('Alice')),
      fixture(0.91, 'speaker-b', speaker('Bob')),
      fixture(0.91, 'condition-a', { ...context, condition: { value: 'if it rains', resolution: 'resolved' as const } }),
      fixture(0.91, 'condition-b', { ...context, condition: { value: 'if it snows', resolution: 'resolved' as const } }),
      fixture(0.91, 'condition-unknown', { ...context, condition: { value: null, resolution: 'unresolved' as const } }),
      fixture(0.91, 'unknown-a', { ...context, speaker: { value: null, resolution: 'unresolved' as const } }),
      fixture(0.91, 'unknown-b', { ...context, speaker: { value: null, resolution: 'unresolved' as const } })]
    for (const item of inputs) {
      const assessed = assessGraphClaim(item.run, item.fact,
        { sensitivity: 'normal', sharePolicy: 'allow-remote' }, 1_800_000_000_000)
      const review = assessed.status === 'approved' ? assessed
        : confirmGraphClaim(assessed, 'Reviewed the uncertain context', 1_800_000_000_000)
      expect((await writer.submit(item.run, item.fact, review, entities))?.state).toBe('published')
    }
    expect(new Set(l1.claims().map(claim => claim.context.id)).size).toBe(inputs.length)
    expect(l1.contexts().filter(item => item.scenario === 'unknown')).toHaveLength(1)
    expect(l1.contexts().filter(item => item.scenario === 'hypothetical')).toHaveLength(2)
    const anotherScope = { ownerId: 'another-owner', agentId: 'agent' }
    const separate = fixture(0.91, 'other-owner')
    const review = assessGraphClaim(separate.run, separate.fact,
      { sensitivity: 'normal', sharePolicy: 'allow-remote' }, 1_800_000_000_000)
    const otherEntities = entities.map(entity => ({ ...entity, scope: anotherScope }))
    expect((await createGraphL1Writer(v4, l1, createGraphPredicateRegistry(), anotherScope)
      .submit(separate.run, separate.fact, review, otherEntities))?.state).toBe('published')
    expect(l1.claims().at(-1)!.context.id).not.toBe(l1.claims()[0]!.context.id)
  })

  it('normalizes equivalent condition text without merging different conditions', async () => {
    const v4 = createMemoryV4Repository({ now: () => 1_800_000_000_000 })
    const l1 = createGraphL1Store(memoryPersistence())
    const writer = createGraphL1Writer(v4, l1, createGraphPredicateRegistry(), scope)
    for (const [sourceId, conditionText] of [['condition-one', 'if   it rains'],
      ['condition-two', 'if it rains']] as const) {
      const item = fixture(0.91, sourceId, { ...context,
        condition: { value: conditionText, resolution: 'resolved' } })
      const confirmed = confirmGraphClaim(assessGraphClaim(item.run, item.fact,
        { sensitivity: 'normal', sharePolicy: 'allow-remote' }, 1_800_000_000_000),
      'Confirmed the condition', 1_800_000_000_000)
      expect((await writer.submit(item.run, item.fact, confirmed, entities))?.state).toBe('published')
    }
    expect(l1.claims()[0]!.context).toEqual(l1.claims()[1]!.context)
    expect(l1.contexts()).toMatchObject([{ scenario: 'hypothetical', frame: {
      condition: { kind: 'conditional', text: 'if it rains' }, isolation: 'shared' } }])
  })

  it('migrates published per-task contexts into one shared frame on store load', async () => {
    const persistence = memoryPersistence()
    const v4 = createMemoryV4Repository({ now: () => 1_800_000_000_000 })
    const l1 = createGraphL1Store(persistence)
    const writer = createGraphL1Writer(v4, l1, createGraphPredicateRegistry(), scope)
    for (const sourceId of ['old-one', 'old-two']) {
      const { run, fact } = fixture(0.91, sourceId)
      await writer.submit(run, fact, assessGraphClaim(run, fact,
        { sensitivity: 'normal', sharePolicy: 'allow-remote' }, 1_800_000_000_000), entities)
    }
    const stored = JSON.parse(persistence.load()!) as { claims: Array<{ ref: { id: string }; context: { id: string } }>;
      contexts: Array<{ ref: { id: string } }> }
    stored.claims.forEach(claim => {
      claim.context.id = `graph-context:${createHash('sha256').update(claim.ref.id).digest('hex').slice(0, 32)}`
    })
    stored.contexts = stored.claims.map((claim, index) => ({ ...l1.contexts()[0]!, ref: {
      ...l1.contexts()[0]!.ref, id: claim.context.id }, frame: undefined,
      provenance: { ...l1.contexts()[0]!.provenance, sources: [l1.claims()[index]!.provenance.sources[0]!] },
    }))
    persistence.save(JSON.stringify(stored))
    const migrated = createGraphL1Store(persistence)
    expect(migrated.claims()[0]!.context).toEqual(migrated.claims()[1]!.context)
    expect(migrated.contexts()).toHaveLength(1)
    expect(migrated.contexts()[0]!.provenance.sources).toHaveLength(2)
  })

  it('writes V4 Fact and version first, then a sourced Claim and claim-backed edge', async () => {
    const v4Persistence = memoryPersistence()
    const l1Persistence = memoryPersistence()
    const v4 = createMemoryV4Repository({ persistence: v4Persistence, now: () => 1_800_000_000_000 })
    const l1 = createGraphL1Store(l1Persistence)
    const registry = createGraphPredicateRegistry()
    const writer = createGraphL1Writer(v4, l1, registry, scope)
    const { run, fact } = fixture()
    const review = assessGraphClaim(run, fact, { sensitivity: 'private', sharePolicy: 'local-only' }, 1_800_000_000_000)
    expect(review).toMatchObject({ status: 'approved', modelScore: 0.91, userConfirmed: false,
      retrieval: { retain: true }, proactive: { useAsPreference: false } })

    const task = await writer.submit(run, fact, review, entities)
    expect(task?.state).toBe('published')
    const snapshot = v4.snapshot()
    const claim = l1.claims()[0]!
    expect(snapshot.facts).toHaveLength(1)
    expect(snapshot.factVersions).toHaveLength(1)
    expect(claim.fact).toEqual({ kind: 'v4-fact', id: snapshot.facts[0]!.id, version: 1 })
    expect(claim).toMatchObject({ sensitivity: 'private', sharePolicy: 'local-only',
      atom: { predicate: 'worksAt', args: { person: { kind: 'entity', ref: { id: 'person-alex', version: 3 } },
        organization: { kind: 'entity', ref: { id: 'org-acme', version: 2 } } } },
      polarity: 'positive', modality: 'asserted', validTime: { kind: 'interval' },
      temporalSource: { value: '2026-09-26', resolution: 'resolved' } })
    expect(claim.provenance.sources[0]?.locator).toEqual({ kind: 'text-span', unit: 'utf16', start: 0, end: 18 })
    expect(l1.edges()[0]).toMatchObject({ from: { id: 'person-alex' }, to: { id: 'org-acme' },
      predicate: 'worksAt', claimRef: claim.ref })
    expect(l1.contexts()).toHaveLength(1)
    expect(snapshot.facts[0]).toMatchObject({ extractionScore: 0.91, userConfirmed: false,
      metadata: { retrievalRetain: true, proactivePreference: false } })
    expect(createMemoryV4Repository({ persistence: v4Persistence }).snapshot().factVersions).toHaveLength(1)
    expect(createGraphL1Store(l1Persistence).claims()).toHaveLength(1)
  })

  it('retains a durable task across L1 failure and retries without duplicating the V4 Fact', async () => {
    const v4 = createMemoryV4Repository({ now: () => 1_800_000_000_000 })
    let payload: string | undefined
    let failPublish = true
    const persistence = { load: () => payload, save: (next: string) => {
      if (failPublish && (JSON.parse(next) as { claims: unknown[] }).claims.length > 0) {
        failPublish = false
        throw new Error('simulated L1 disk failure')
      }
      payload = next
    } }
    const l1 = createGraphL1Store(persistence)
    const registry = createGraphPredicateRegistry()
    const { run, fact } = fixture()
    const review = assessGraphClaim(run, fact, { sensitivity: 'normal', sharePolicy: 'allow-remote' }, 1_800_000_000_000)
    const first = await createGraphL1Writer(v4, l1, registry, scope).submit(run, fact, review, entities)
    expect(first?.state).not.toBe('published')
    expect(v4.snapshot().factVersions).toHaveLength(1)
    expect(l1.claims()).toHaveLength(0)
    expect(l1.tasks()).toHaveLength(1)
    expect(l1.tasks()[0]).toMatchObject({ state: 'fact-persisted', factRef: { kind: 'v4-fact', version: 1 } })

    const restarted = createGraphL1Store(persistence)
    await createGraphL1Writer(v4, restarted, registry, scope).retryPending()
    expect(restarted.tasks()[0]?.state).toBe('published')
    expect(restarted.claims()).toHaveLength(1)
    expect(v4.snapshot().factVersions).toHaveLength(1)
  })

  it('keeps pending review out of V4 and records user confirmation separately from model score', async () => {
    const v4 = createMemoryV4Repository({ now: () => 1_800_000_000_000 })
    const l1 = createGraphL1Store(memoryPersistence())
    const writer = createGraphL1Writer(v4, l1, createGraphPredicateRegistry(), scope)
    const { run, fact } = fixture(0.6)
    const pending = assessGraphClaim(run, fact, { sensitivity: 'private', sharePolicy: 'local-only' }, 1_800_000_000_000)
    expect(pending.status).toBe('pending')
    expect(deferGraphClaim(pending, 'Wait for source check')).toMatchObject({ status: 'pending', reason: 'Wait for source check' })
    expect(rejectGraphClaim(pending, 'Incorrect company')).toMatchObject({ status: 'rejected', reason: 'Incorrect company' })
    expect(await writer.submit(run, fact, pending, entities)).toBeUndefined()
    expect(v4.snapshot().facts).toHaveLength(0)
    const confirmed = confirmGraphClaim(pending, 'User checked the source assertion', 1_800_000_000_100)
    expect(() => setGraphUseAssessment(pending, { retrievalRetain: true,
      proactivePreference: true, reason: 'use as preference' })).toThrow(/confirmation/)
    const independentlyAssessed = setGraphUseAssessment(confirmed, {
      retrievalRetain: true, proactivePreference: false, reason: 'searchable company fact only',
    })
    expect(independentlyAssessed).toMatchObject({ retrieval: { retain: true }, proactive: { useAsPreference: false } })
    await writer.submit(run, fact, confirmed, entities)
    expect(v4.snapshot().facts[0]).toMatchObject({ extractionScore: 0.6, userConfirmed: true,
      sensitivity: 'private', sharePolicy: 'local-only', origin: 'manual' })
    expect(l1.reviews()[0]).toMatchObject({ status: 'approved', reviewer: 'user',
      modelScore: 0.6, userConfirmed: true, sourceId: 'message-1' })
  })

  it('does not publish a Claim when the V4 transaction fails, then replays the durable task', async () => {
    let v4Payload: string | undefined
    let failV4 = true
    const v4 = createMemoryV4Repository({ now: () => 1_800_000_000_000, persistence: {
      load: () => v4Payload,
      save: (next) => {
        if (failV4) { failV4 = false; throw new Error('simulated V4 disk failure') }
        v4Payload = next
      },
    } })
    const l1Persistence = memoryPersistence()
    const l1 = createGraphL1Store(l1Persistence)
    const registry = createGraphPredicateRegistry()
    const { run, fact } = fixture()
    const review = assessGraphClaim(run, fact, { sensitivity: 'normal', sharePolicy: 'allow-remote' }, 1_800_000_000_000)
    await createGraphL1Writer(v4, l1, registry, scope).submit(run, fact, review, entities)
    expect(v4.snapshot().factVersions).toHaveLength(0)
    expect(l1.claims()).toHaveLength(0)
    expect(l1.tasks()[0]?.state).toBe('queued')
    await createGraphL1Writer(v4, createGraphL1Store(l1Persistence), registry, scope).retryPending()
    expect(v4.snapshot().factVersions).toHaveLength(1)
    expect(createGraphL1Store(l1Persistence).claims()).toHaveLength(1)
  })

  it('publishes a graph-core bundle and recalls accepted entity facts with exact V4 evidence', async () => {
    const v4 = createMemoryV4Repository({ now: () => 1_800_000_000_000 })
    const l1 = createGraphL1Store(memoryPersistence())
    const registry = createGraphPredicateRegistry()
    const semanticPersistence = memoryPersistence()
    const semantic = createGraphSemanticRepository(semanticPersistence, v4)
    const syncFromClaims = async () => {
      const result = await semantic.syncFromClaims(l1, v4, registry, scope)
      if (!result.ok) throw new Error(result.error.message)
    }
    const writer = createGraphL1Writer(v4, l1, registry, scope, { syncFromClaims })
    const { run, fact } = fixture()
    const review = assessGraphClaim(run, fact, { sensitivity: 'private', sharePolicy: 'local-only' }, 1_800_000_000_000)
    expect((await writer.submit(run, fact, review, entities))?.state).toBe('published')
    expect(semantic.snapshot()).toMatchObject({ claims: [{ atom: { predicate: 'worksAt' } }],
      entities: [{ ref: { id: 'org-acme' }, review: { status: 'accepted', reviewedAt: 1_800_000_000_000 } },
        { ref: { id: 'person-alex' }, review: { status: 'accepted', reviewedAt: 1_800_000_000_000 } }],
      predicates: [{ name: 'worksAt' }] })
    expect(createGraphSemanticRepository(semanticPersistence, v4).snapshot()?.claims).toHaveLength(1)
    expect(selectRetrievableGraphBundle(semantic.snapshot(), [{ ...l1.tasks()[0]!,
      review: { ...review, retrieval: { retain: false } } }])?.claims).toHaveLength(0)
    const graph = createV4GraphMemory({ repository: v4, persistence: memoryPersistence(),
      authorizeScope: () => true, canRead: () => true, countTokens: text => Buffer.byteLength(text),
      now: () => 1_800_000_000_000, acceptedBundle: () => semantic.snapshot() })
    const request: GraphRecallRequest = { protocolVersion: 'memory-graph/v1', recallId: 'entity-recall',
      query: 'Acme', scope, temporal: { knownAt: 1_800_000_000_000,
        valid: { kind: 'at', at: Date.UTC(2026, 8, 26, 12) } }, mode: 'direct-only',
      budget: { ...V4_GRAPH_BUDGET }, sharePolicies: ['local-only'], sensitivities: ['private'] }
    const found = await graph.recall(request)
    expect(found).toMatchObject({ ok: true, value: { evidence: { claims: [{ ref: l1.claims()[0]!.ref,
      content: 'Alex works at Acme' }] } } })
    expect(await graph.recall({ ...request, recallId: 'privacy-denied',
      sharePolicies: ['allow-remote'], sensitivities: ['normal'] }))
      .toMatchObject({ ok: true, value: { evidence: { claims: [] } } })
    v4.transaction(draft => { draft.episodes[0]!.contentState = 'deleted';
      draft.episodes[0]!.deletedAt = 1_800_000_000_001; delete draft.episodes[0]!.content })
    expect(await graph.recall({ ...request, recallId: 'after-delete' }))
      .toMatchObject({ ok: true, value: { evidence: { claims: [] } } })
    await syncFromClaims()
    expect(semantic.snapshot()?.claims).toHaveLength(0)
  })

  it('retries graph-core bundle publication after its encrypted save fails', async () => {
    const v4 = createMemoryV4Repository({ now: () => 1_800_000_000_000 })
    const l1 = createGraphL1Store(memoryPersistence())
    const registry = createGraphPredicateRegistry()
    let stored: string | undefined
    let fail = true
    const persistence = { load: () => stored, save: (payload: string) => {
      if (fail) { fail = false; throw new Error('bundle disk failure') }
      stored = payload
    } }
    const semantic = createGraphSemanticRepository(persistence, v4)
    const syncFromClaims = async () => {
      const result = await semantic.syncFromClaims(l1, v4, registry, scope)
      if (!result.ok) throw new Error(result.error.message)
    }
    const writer = createGraphL1Writer(v4, l1, registry, scope, { syncFromClaims })
    const { run, fact } = fixture()
    const review = assessGraphClaim(run, fact, { sensitivity: 'normal', sharePolicy: 'allow-remote' }, 1_800_000_000_000)
    expect((await writer.submit(run, fact, review, entities))?.state).toBe('fact-persisted')
    expect(l1.claims()).toHaveLength(1)
    expect(semantic.snapshot()).toBeUndefined()
    await writer.retryPending()
    expect(l1.tasks()[0]?.state).toBe('published')
    expect(semantic.snapshot()?.claims).toHaveLength(1)
    expect(v4.snapshot().facts).toHaveLength(1)
  })

  it('retrieves confirmed source material with unresolved polarity and time as incomplete evidence', async () => {
    const v4 = createMemoryV4Repository({ now: () => 1_800_000_000_000 })
    const l1 = createGraphL1Store(memoryPersistence())
    const registry = createGraphPredicateRegistry()
    const semantic = createGraphSemanticRepository(memoryPersistence(), v4)
    const { run, fact } = fixture()
    run.factCandidates[0]!.context.negation = { value: null, resolution: 'unresolved' }
    run.factCandidates[0]!.context.time = { value: null, resolution: 'unresolved' }
    const pending = assessGraphClaim(run, fact, { sensitivity: 'normal', sharePolicy: 'allow-remote' }, 1_800_000_000_000)
    const confirmed = confirmGraphClaim(pending, 'I verified the cited source', 1_800_000_000_000)
    const writer = createGraphL1Writer(v4, l1, registry, scope, { syncFromClaims: async () => {
      const result = await semantic.syncFromClaims(l1, v4, registry, scope)
      if (!result.ok) throw new Error(result.error.message)
    } })
    expect((await writer.submit(run, fact, confirmed, entities))?.state).toBe('published')
    const graph = createV4GraphMemory({ repository: v4, persistence: memoryPersistence(),
      authorizeScope: () => true, canRead: () => true, countTokens: text => Buffer.byteLength(text),
      now: () => 1_800_000_000_000, acceptedBundle: () => semantic.snapshot() })
    expect(await graph.recall({ protocolVersion: 'memory-graph/v1', recallId: 'uncertain', query: 'Acme', scope,
      temporal: { knownAt: 1_800_000_000_000, valid: { kind: 'at', at: 1_800_000_000_000 } },
      mode: 'direct-only', budget: { ...V4_GRAPH_BUDGET }, sharePolicies: ['allow-remote'],
      sensitivities: ['normal'] })).toMatchObject({ ok: true, value: { evidence: { claims: [
        { polarity: 'unknown', validTime: { kind: 'unknown' } }] }, trace: { completeness: 'incomplete' } } })
  })

  it('keeps a confirmed but unresolved condition outside complete actual-context recall', async () => {
    const v4 = createMemoryV4Repository({ now: () => 1_800_000_000_000 })
    const l1 = createGraphL1Store(memoryPersistence())
    const registry = createGraphPredicateRegistry()
    const semantic = createGraphSemanticRepository(memoryPersistence(), v4)
    const item = fixture(0.91, 'uncertain-condition', { ...context,
      condition: { value: null, resolution: 'unresolved' } })
    const review = confirmGraphClaim(assessGraphClaim(item.run, item.fact,
      { sensitivity: 'normal', sharePolicy: 'allow-remote' }, 1_800_000_000_000),
    'Reviewed the cited text', 1_800_000_000_000)
    const writer = createGraphL1Writer(v4, l1, registry, scope, { syncFromClaims: async () => {
      const result = await semantic.syncFromClaims(l1, v4, registry, scope)
      if (!result.ok) throw new Error(result.error.message)
    } })
    expect((await writer.submit(item.run, item.fact, review, entities))?.state).toBe('published')
    expect(semantic.snapshot()?.contexts[0]?.scenario).toBe('unknown')
    const graph = createV4GraphMemory({ repository: v4, persistence: memoryPersistence(),
      authorizeScope: () => true, canRead: () => true, countTokens: text => Buffer.byteLength(text),
      now: () => 1_800_000_000_000, acceptedBundle: () => semantic.snapshot() })
    expect(await graph.recall({ protocolVersion: 'memory-graph/v1', recallId: 'unresolved-condition',
      query: 'Acme', scope, temporal: { knownAt: 1_800_000_000_000,
        valid: { kind: 'at', at: Date.UTC(2026, 8, 26, 12) } }, mode: 'direct-only',
      budget: { ...V4_GRAPH_BUDGET }, sharePolicies: ['allow-remote'], sensitivities: ['normal'] }))
      .toMatchObject({ ok: true, value: { trace: { completeness: 'incomplete' } } })
  })
})
