import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { MEMORY_GRAPH_PROTOCOL_VERSION } from '@continuum-memory/contracts'
import type { GraphRecallRequest, GraphResult } from '@continuum-memory/contracts'
import type { GraphProjectionManifest } from '../domain/types'
import type { GraphRecallReadView as GraphReadView, GraphRecallSeedPort as GraphSeedPort } from '../ports/graph-recall-ports'
import { createFeverAbsenceFixture, FEVER_ABSENCE_DAY, FEVER_ABSENCE_RECORDED_AT } from '../fixtures/fever-absence'
import { createInMemoryGraph } from '../repository/in-memory-graph'
import { createOneHopGraphRecall } from './one-hop-recall'
import type { QueryOneHopGraphRecallRequest } from './one-hop-recall'

function value<T>(result: GraphResult<T>): T {
  if (!result.ok) throw new Error(result.error.code)
  return result.value
}

function setup(data = createFeverAbsenceFixture(), options: {
  maxSeedScanned?: number
  clock?: () => number
  wrapSeeds?: (port: GraphSeedPort) => GraphSeedPort
} = {}) {
  let authorized = true
  const access = { accessContextId: 'test', authorizationVersion: '1', scope: data.bundle.scope,
    sharePolicies: ['allow-remote' as const], sensitivities: ['normal' as const] }
  const manifest: GraphProjectionManifest = {
    protocolVersion: MEMORY_GRAPH_PROTOCOL_VERSION, schemaVersion: 1, manifestId: 'm1', sourceBundleId: data.bundle.bundleId,
    scope: data.bundle.scope, sourceRevisions: data.bundle.revisions,
    semanticFingerprint: createHash('sha256').update(JSON.stringify(data.bundle)).digest('hex'),
    builderVersion: 'test', navigationRevision: 0, createdAt: FEVER_ABSENCE_RECORDED_AT, state: 'ready',
  }
  const store = createInMemoryGraph({ data, manifest, resolveAccess: () => authorized ? access : undefined,
    countTokens: () => 1, clock: options.clock ?? (() => 0), maxSeedScanned: options.maxSeedScanned })
  let lastView: GraphReadView | undefined
  const openView = vi.fn(async (request: QueryOneHopGraphRecallRequest['view']) => {
    const result = await store.openView(request)
    if (result.ok) { lastView = result.value; vi.spyOn(lastView, 'close'); vi.spyOn(lastView, 'neighbors') }
    return result
  })
  const service = createOneHopGraphRecall({ readPort: { openView }, evidenceReader: store.evidenceReader,
    seedPort: options.wrapSeeds?.(store.seedPort) ?? store.seedPort })
  const request: QueryOneHopGraphRecallRequest = {
    recallId: 'query-1', query: '张三为什么没有上班？', view: {
      access, expectedManifestId: 'm1', policyVersion: 'lexical-test-v1',
      temporal: { valid: { kind: 'at', at: FEVER_ABSENCE_DAY + 1 }, knownAt: FEVER_ABSENCE_RECORDED_AT + 1 },
      budget: { maxSeeds: 1, maxNodes: 10, maxEdges: 20, maxHops: 1, maxRuleBindings: 0, maxProofSteps: 0,
        maxElapsedMs: 1000, maxEvidenceTokens: 100 },
    },
  }
  const seedRequest = (query = request.query): GraphRecallRequest => ({
    protocolVersion: MEMORY_GRAPH_PROTOCOL_VERSION, recallId: request.recallId, query, mode: 'direct-only',
    scope: request.view.access.scope, temporal: request.view.temporal, budget: request.view.budget,
    sharePolicies: request.view.access.sharePolicies, sensitivities: request.view.access.sensitivities,
    expectedManifestId: request.view.expectedManifestId,
  })
  return { store, service, request, seedRequest, openView, lastView: () => lastView!,
    revokeAccess: () => { authorized = false } }
}

describe('lexical seeds connected to one-hop recall', () => {
  it('plans yesterday before opening the view, preserves knownAt and leaves caller input untouched', async () => {
    const s = setup()
    const request = { ...s.request, query: '张三昨天为什么没有上班？',
      view: { ...s.request.view, temporal: { ...s.request.view.temporal, valid: { kind: 'at' as const, at: 0 } } },
      timePlanning: { referenceTime: FEVER_ABSENCE_RECORDED_AT, utcOffsetMinutes: 480 } }
    const result = value(await s.service.recallQuery(request))
    expect(result.status).toBe('recalled')
    expect(result.seeds.items[0]!.ref.id).toBe('C2')
    expect(result.recall!.groups).toHaveLength(1)
    expect(result.timePlan).toMatchObject({ source: 'query', expression: '昨天',
      temporal: { knownAt: s.request.view.temporal.knownAt,
        valid: { kind: 'overlap', from: FEVER_ABSENCE_DAY, to: FEVER_ABSENCE_DAY + 86400000 } } })
    expect(s.openView.mock.calls[0]![0].temporal).toEqual(result.timePlan!.temporal)
    expect(request.view.temporal.valid).toEqual({ kind: 'at', at: 0 })
    expect(request.query).toContain('昨天')
    expect(s.openView).toHaveBeenCalledOnce()
  })

  it('supports a planned date range without sending two dates to the single-date seed adapter', async () => {
    const s = setup()
    const result = value(await s.service.recallQuery({ ...s.request,
      query: '张三从2026年9月19日到2026年9月20日为什么没有上班？',
      timePlanning: { referenceTime: FEVER_ABSENCE_RECORDED_AT, utcOffsetMinutes: 480 } }))
    expect(result.seeds.items[0]!.ref.id).toBe('C2')
    expect(result.timePlan!.lexicalQuery).not.toContain('2026')
    expect(result.recall!.groups).toHaveLength(1)
  })

  it('does not use referenceTime as knownAt to reveal facts recorded later', async () => {
    const s = setup()
    const result = value(await s.service.recallQuery({ ...s.request, query: '张三昨天为什么没上班？',
      view: { ...s.request.view, temporal: { ...s.request.view.temporal, knownAt: FEVER_ABSENCE_RECORDED_AT - 1 } },
      timePlanning: { referenceTime: FEVER_ABSENCE_RECORDED_AT + 1000, utcOffsetMinutes: 480 } }))
    expect(result.status).toBe('no-match')
  })

  it('requires explicit reference context for relative time instead of guessing the current date', async () => {
    const s = setup()
    expect(await s.service.recallQuery({ ...s.request, query: '张三昨天为什么没上班？' }))
      .toMatchObject({ ok: false, error: { code: 'invalid-request' } })
    expect(s.openView).not.toHaveBeenCalled()
  })

  it('rejects ambiguous planned time before opening the view', async () => {
    const s = setup()
    expect(await s.service.recallQuery({ ...s.request, query: '张三昨天和今天为什么没上班？',
      timePlanning: { referenceTime: FEVER_ABSENCE_RECORDED_AT, utcOffsetMinutes: 480 } }))
      .toMatchObject({ ok: false, error: { code: 'invalid-request' } })
    expect(s.openView).not.toHaveBeenCalled()
  })

  it('locates the absence claim and follows its incoming cause with one shared view', async () => {
    const s = setup()
    const result = value(await s.service.recallQuery(s.request))
    expect(result.status).toBe('recalled')
    expect(result.seeds.items[0]).toMatchObject({ ref: { kind: 'claim', id: 'C2', version: 1 }, route: 'lexical' })
    expect(result.recall!.claims.map(item => item.record.ref.id)).toEqual(['C2', 'C1'])
    expect(result.recall!.groups[0]).toMatchObject({ from: { id: 'C1' }, to: { id: 'C2' } })
    expect(result.recall!.sources[0]!.content).toContain('因为发烧')
    expect(result.recall!.searchScope).toMatchObject({ direction: 'in', kinds: ['causal', 'contributes-to'] })
    expect(s.openView).toHaveBeenCalledOnce()
    expect(s.lastView().close).toHaveBeenCalledOnce()
  })

  it.each(['张三2026年9月20日为什么没有上班？', '张三2026-09-20为什么没上班？'])('supports an explicit date in %s', async query => {
    const s = setup()
    const result = value(await s.service.recallQuery({ ...s.request, query }))
    expect(result.seeds.items[0]!.ref.id).toBe('C2')
  })

  it('does not silently substitute a different date when query and view disagree', async () => {
    const s = setup()
    const result = value(await s.service.recallQuery({ ...s.request, query: '张三2026年9月10日为什么没有上班？' }))
    expect(result.status).toBe('no-match')
    expect(result.recall).toBeNull()
    expect(s.lastView().neighbors).not.toHaveBeenCalled()
  })

  it('selects the explicit date even when both dates are inside an overlap query', async () => {
    const s = setup()
    const result = value(await s.service.recallQuery({ ...s.request, query: '张三2026-09-10为什么没有上班？',
      view: { ...s.request.view, temporal: { ...s.request.view.temporal,
        valid: { kind: 'overlap', from: FEVER_ABSENCE_DAY - 11 * 86400000, to: FEVER_ABSENCE_DAY + 86400000 } } } }))
    expect(result.seeds.items[0]!.ref.id).toBe('C3')
    expect(result.recall!.relations).toHaveLength(0)
    expect(result.recall!.claims).toHaveLength(1)
  })

  it.each(['天气为什么变冷？', '张三为什么喜欢音乐？'])('abstains on insufficient lexical evidence: %s', async query => {
    const s = setup()
    const result = value(await s.service.recallQuery({ ...s.request, query }))
    expect(result).toMatchObject({ status: 'no-match', recall: null, seeds: { items: [] } })
    expect(s.lastView().close).toHaveBeenCalledOnce()
  })

  it.each(['他为什么没有上班？', '为什么？', '张三的记忆', '为什么缺勤，之后发生了什么？'])(
    'requests clarification without searching or expanding: %s', async query => {
      const s = setup()
      const result = value(await s.service.recallQuery({ ...s.request, query }))
      expect(result).toMatchObject({ status: 'needs-clarification', recall: null,
        queryPlan: { status: 'needs-clarification', traversal: null }, seeds: { items: [], scanned: 0 } })
      expect(s.openView).not.toHaveBeenCalled()
    })

  it('finds effects in the outgoing direction using the event, not the question suffix, as the seed query', async () => {
    const s = setup()
    const result = value(await s.service.recallQuery({ ...s.request, query: '张三发烧造成了什么影响？' }))
    expect(result.queryPlan).toMatchObject({ questionType: 'effect', searchQuery: '张三发烧', missingInformation: 'effect' })
    expect(result.seeds.items[0]!.ref.id).toBe('C1')
    expect(result.recall!.groups[0]).toMatchObject({ from: { id: 'C1' }, to: { id: 'C2' } })
    expect(result.recall!.searchScope.direction).toBe('out')
  })

  it('does not treat cause edges as evidence for a before-event question', async () => {
    const s = setup()
    const result = value(await s.service.recallQuery({ ...s.request, query: '张三没有上班之前发生了什么？' }))
    expect(result.queryPlan).toMatchObject({ questionType: 'before', missingInformation: 'earlier-event' })
    expect(result.seeds.items[0]!.ref.id).toBe('C2')
    expect(result.recall!.relations).toEqual([])
    expect(result.recall!.searchScope).toMatchObject({ direction: 'in', kinds: ['before'] })
  })

  it('enforces host-resolved entity identity on seeds, including its exact version', async () => {
    const s = setup()
    const query = '他为什么没有上班？'
    const entities = [{ kind: 'entity' as const, id: 'zhang-san', version: 1 }]
    const matched = value(await s.service.recallQuery({ ...s.request, query, constraints: { entities } }))
    expect(matched.status).toBe('recalled')
    expect(matched.queryPlan.target.entityResolution).toBe('host-resolved')
    for (const refs of [
      [{ ...entities[0]!, version: 99 }],
      [...entities, { kind: 'entity' as const, id: 'other', version: 1 }],
    ]) {
      const excluded = value(await s.service.recallQuery({ ...s.request, query, constraints: { entities: refs } }))
      expect(excluded.status).toBe('no-match')
    }
  })

  it('does not use the fever claim as the absence seed just because it shares the source', async () => {
    const data = createFeverAbsenceFixture()
    Object.assign(data.bundle.claims[1]!, { review: { status: 'candidate' } })
    const s = setup(data)
    expect(value(await s.service.recallQuery(s.request)).status).toBe('no-match')
  })

  it('honors explicit traversal instead of the why heuristic', async () => {
    const s = setup()
    const result = value(await s.service.recallQuery({ ...s.request, direction: 'out', kinds: ['before'] }))
    expect(result.recall!.searchScope).toMatchObject({ direction: 'out', kinds: ['before'] })
    expect(result.recall!.relations).toHaveLength(0)
  })

  it('shares node and evidence budgets without charging seed index text as answer evidence', async () => {
    const s = setup()
    const complete = value(await s.service.recallQuery({ ...s.request,
      view: { ...s.request.view, budget: { ...s.request.view.budget, maxEvidenceTokens: 3 } } }))
    expect(complete.recall!.groups).toHaveLength(1)
    const limited = value(await s.service.recallQuery({ ...s.request,
      view: { ...s.request.view, budget: { ...s.request.view.budget, maxNodes: 1 } } }))
    expect(limited.recall).toMatchObject({ completeness: 'incomplete', groups: [] })
    expect(limited.recall!.claims.map(item => item.record.ref.id)).toEqual(['C2'])
  })

  it('does not select a winner or claim no-match when scanning was truncated', async () => {
    const s = setup(undefined, { maxSeedScanned: 2 })
    const result = value(await s.service.recallQuery(s.request))
    expect(result).toMatchObject({ status: 'seed-search-incomplete', recall: null,
      seeds: { items: [], scanned: 2, completion: 'budget-exhausted' } })
    expect(s.lastView().neighbors).not.toHaveBeenCalled()
    expect(s.lastView().close).toHaveBeenCalledOnce()
  })

  it('handles zero seeds without allowing the BM25 minimum limit to return one', async () => {
    const s = setup()
    const result = value(await s.service.recallQuery({ ...s.request,
      view: { ...s.request.view, budget: { ...s.request.view.budget, maxSeeds: 0 } } }))
    expect(result.status).toBe('seed-search-incomplete')
    expect(result.seeds.items).toHaveLength(0)
  })

  it('filters private claims before ranking, even if the request asks for them', async () => {
    const data = createFeverAbsenceFixture()
    Object.assign(data.bundle.claims[1]!, { sensitivity: 'private' })
    const s = setup(data)
    expect(value(await s.service.recallQuery({ ...s.request, view: { ...s.request.view,
      access: { ...s.request.view.access, sensitivities: ['normal', 'private'] } } })).status).toBe('no-match')
  })

  it('does not let a source deletion between seed selection and expansion expose evidence', async () => {
    const s = setup(undefined, { wrapSeeds: port => ({ async search(request, view) {
      const result = await port.search(request, view)
      s.store.revokeSource('E1')
      return result
    } }) })
    expect(await s.service.recallQuery(s.request)).toMatchObject({ ok: false, error: { code: 'source-unavailable' } })
    expect(s.lastView().close).toHaveBeenCalledOnce()
  })

  it('does not reset elapsed time after seed search', async () => {
    let now = 0
    const s = setup(undefined, { clock: () => now, wrapSeeds: port => ({ async search(request, view) {
      const result = await port.search(request, view)
      now = 1000
      return result
    } }) })
    expect(await s.service.recallQuery(s.request)).toMatchObject({ ok: false, error: { code: 'budget-exhausted' } })
    expect(s.openView).toHaveBeenCalledOnce()
  })

  it.each(['张三2026-02-30为什么没上班', '张三2026-09-10到2026-09-20上班情况'])('rejects an invalid or ambiguous date plan: %s', async query => {
    const s = setup()
    expect(await s.service.recallQuery({ ...s.request, query })).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
    expect(s.openView).not.toHaveBeenCalled()
  })

  it('keeps seed counts and scan limits cumulative across searches in the same view', async () => {
    const s = setup()
    const view = value(await s.store.openView(s.request.view))
    expect(value(await s.store.seedPort.search(s.seedRequest(), view)).items[0]!.ref.id).toBe('C2')
    expect(value(await s.store.seedPort.search(s.seedRequest('张三为什么发烧？'), view)).completion).toBe('budget-exhausted')
    await view.close()
    const small = setup(undefined, { maxSeedScanned: 3 })
    const limited = value(await small.store.openView(small.request.view))
    expect(value(await small.store.seedPort.search(small.seedRequest(), limited)).completion).toBe('complete')
    expect(value(await small.store.seedPort.search(small.seedRequest(), limited)).completion).toBe('budget-exhausted')
    await limited.close()
  })

  it('rejects mismatched scope, time, budget, unsupported mode and fabricated views', async () => {
    const s = setup()
    const view = value(await s.store.openView(s.request.view))
    for (const patch of [
      { scope: { ...s.request.view.access.scope, ownerId: 'other' } },
      { temporal: { ...s.request.view.temporal, knownAt: 0 } },
      { budget: { ...s.request.view.budget, maxNodes: 999 } },
    ]) {
      expect(await s.store.seedPort.search({ ...s.seedRequest(), ...patch }, view))
        .toMatchObject({ ok: false, error: { code: 'invalid-request' } })
    }
    expect(await s.store.seedPort.search({ ...s.seedRequest(), mode: 'with-proofs' }, view))
      .toMatchObject({ ok: false, error: { code: 'unsupported-capability' } })
    expect(await s.store.seedPort.search(s.seedRequest(), { ...view }))
      .toMatchObject({ ok: false, error: { code: 'view-closed' } })
    await view.close()
    expect(await s.store.seedPort.search(s.seedRequest(), view)).toMatchObject({ ok: false, error: { code: 'view-closed' } })
  })

  it('rechecks current authorization for seed search', async () => {
    const s = setup()
    const view = value(await s.store.openView(s.request.view))
    s.revokeAccess()
    expect(await s.store.seedPort.search(s.seedRequest(), view)).toMatchObject({ ok: false, error: { code: 'scope-denied' } })
    await view.close()
  })

  it('rejects an empty query before opening a view', async () => {
    const s = setup()
    expect(await s.service.recallQuery({ ...s.request, query: ' ' })).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
    expect(s.openView).not.toHaveBeenCalled()
  })
})
