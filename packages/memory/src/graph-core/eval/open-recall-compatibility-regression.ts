import assert from 'node:assert/strict'
import { createCaptureRepository } from '../../long-term/capture-repository'
import { createGraphExtractionResultStore } from '../../long-term/graph-extraction-result'
import { createGraphL1Store } from '../../long-term/graph-l1-write'
import { createGraphPredicateRegistry } from '../../long-term/graph-identity-normalization'
import { parseUieOutput, uieGraphExtractionRun } from '../../long-term/local-uie'
import { createMemoryV4Repository } from '../../v4/repository/memory-v4-repository'
import { createGraphSemanticRepository } from '../repository/semantic-repository'
import { createGraphL1ProjectionRepository } from '../repository/l1-projection-repository'
import { searchOpenAssertions } from '../repository/open-assertions'
import { searchOpenAssertionsWithContext } from '../repository/open-context-search'
import { createV4GraphMemory, V4_GRAPH_BUDGET } from '../adapters/v4-graph-memory'
import { createV4L2Memory, V4_L2_BUDGET } from '../adapters/v4-l2-memory'
import { createGraphRelationRepository } from '../repository/relation-repository'
import { createV4RelationSourceReader } from '../adapters/v4-relation-sources'
import type { GraphRecallRequest } from '@continuum-memory/contracts'

const scope = { ownerId: 'merge-owner', agentId: 'merge-agent' }
const disk = () => { let value: string | undefined; return { load: () => value, save: (next: string) => { value = next } } }
function fixture() {
  const captures = createCaptureRepository({ persistence: disk() }), extractions = createGraphExtractionResultStore(disk())
  const v4 = createMemoryV4Repository(), l1 = createGraphL1Store(disk()), registry = createGraphPredicateRegistry()
  const semantic = createGraphSemanticRepository(disk(), v4, captures, extractions)
  const projection = createGraphL1ProjectionRepository(disk(), semantic, v4, l1, captures, extractions)
  const append = (text: string, id: string) => {
    captures.register({ userMessage: text, assistantMessage: '', metadata: { sourceMessageIds: [id] } }, scope, 'merge-test')
    extractions.append(uieGraphExtractionRun(id, text, parseUieOutput(text, {})))
  }
  const sync = async () => {
    assert((await semantic.syncFromClaims(l1, v4, registry, scope)).ok)
    const view = projection.sync(); assert(view); return view
  }
  const options = { repository: v4, persistence: disk(), authorizeScope: (s: typeof scope) => s.ownerId === scope.ownerId && s.agentId === scope.agentId,
    canRead: () => true, countTokens: (s: string) => Buffer.byteLength(s), acceptedBundle: () => projection.snapshot()?.semanticBundle }
  const request = (query: string): GraphRecallRequest => { const at = Date.now(); return {
    protocolVersion: 'memory-graph/v1', recallId: 'merge-test', scope, query, mode: 'direct-only',
    temporal: { knownAt: at, valid: { kind: 'at', at } }, sensitivities: ['normal'], sharePolicies: ['local-only', 'allow-remote'], budget: { ...V4_GRAPH_BUDGET },
  } }
  return { captures, extractions, v4, projection, append, sync, options, request }
}

/** Actual upstream extraction/publication + local recall adapters, synthetic source data only. */
export async function runOpenRecallCompatibilityRegression() {
  const checks: { id: string; passed: boolean; error?: string }[] = []
  const test = async (id: string, run: () => Promise<unknown>) => {
    try { await run(); checks.push({ id, passed: true }) } catch (e) { checks.push({ id, passed: false, error: String(e) }) }
  }
  await test('automatic-open-navigation-is-not-canonical-chat-evidence', async () => {
    const f = fixture(); f.append('样品S7存放在恒温箱B2。', 'sample'); f.append('恒温箱B2发生故障。', 'box')
    const view = await f.sync(), records = view.semanticBundle.openAssertions!
    assert.equal(records.length, 2); assert(records.every(r => r.review.status === 'candidate' && r.admission?.localNavigation === 'automatic'))
    assert.equal(f.extractions.openReviews().length, 0)
    const hits = searchOpenAssertions(view.semanticBundle, '样品S7', { scope, maximumDepth: 2 })
    assert.equal(hits.length, 2); assert(hits.every(h => h.verification === 'automatic-navigation'))
    assert.equal(new Set(records.flatMap(r => r.participants.filter(p => p.text === '恒温箱B2').map(p => p.ref.id))).size, 2)
    assert(records.every(r => r.sharePolicy === 'local-only' && r.inferenceAllowed === false && r.admission?.claimPublication === false))
    assert.equal(view.semanticBundle.claims.length, 0); assert.equal(f.v4.snapshot().facts.length, 0)
    const result = await createV4GraphMemory(f.options).recall(f.request('样品S7'))
    assert(result.ok, result.ok ? undefined : result.error.message); assert.equal(result.value.evidence.claims.length, 0)
  })
  await test('open-review-acceptance-does-not-promote-to-L2', async () => {
    const f = fixture(); f.append('样品S7存放在恒温箱B2。', 'sample'); const first = await f.sync(), record = first.semanticBundle.openAssertions![0]!
    f.extractions.recordOpenReview({ assertionId: record.ref.id, sourceId: record.extraction.sourceId,
      sourceRevision: record.extraction.sourceRevision, status: 'accepted', reason: 'synthetic source review', reviewedAt: Date.now() })
    assert.equal(f.projection.snapshot(), undefined)
    const view = await f.sync(); assert.equal(view.semanticBundle.openAssertions![0]!.review.status, 'accepted')
    const relations = createGraphRelationRepository({ coreSnapshot: () => f.projection.snapshot()!, persistence: disk(),
      verifySources: createV4RelationSourceReader(f.options).verify })
    const before = JSON.stringify(relations.snapshot())
    const port = createV4L2Memory({ ...f.options, nativeRelations: { projection: () => f.projection.snapshot(), repository: () => relations } })
    const result = await port.recall({ ...f.request('样品S7相关的记忆'), budget: { ...V4_L2_BUDGET } })
    assert(result.ok, result.ok ? undefined : result.error.message)
    assert.equal(result.value.evidence.claims.length, 0); assert.equal(result.value.evidence.relations?.length, 0)
    assert.equal(JSON.stringify(relations.snapshot()), before)
  })
  await test('qualified-open-records-remain-opt-in-source-candidates', async () => {
    const f = fixture(); f.append('如果设备修好，样品S7存放在恒温箱B2。', 'qualified'); const view = await f.sync()
    assert.equal(searchOpenAssertions(view.semanticBundle, '样品S7', { scope }).length, 0)
    const result = await searchOpenAssertionsWithContext(view.semanticBundle, '样品S7', { scope, includeCandidates: true })
    assert.equal(result.items.length, 1); assert.equal(result.items[0]!.verification, 'unverified-candidate')
    assert.equal(result.items[0]!.assertion.context.condition.resolution, 'unresolved')
    assert.equal(view.semanticBundle.claims.length, 0)
  })
  await test('source-change-and-rejection-invalidate-open-projections', async () => {
    const f = fixture(); f.append('样品S7存放在恒温箱B2。', 'sample'); const view = await f.sync(), record = view.semanticBundle.openAssertions![0]!
    f.extractions.recordOpenReview({ assertionId: record.ref.id, sourceId: record.extraction.sourceId,
      sourceRevision: record.extraction.sourceRevision, status: 'rejected', reason: 'synthetic rejection', reviewedAt: Date.now() })
    assert.equal(f.projection.snapshot(), undefined)
    assert.equal((await f.sync()).edges.filter(e => e.kind === 'open-participant').length, 0)
    f.captures.register({ userMessage: '样品S7存放在冷柜C3。', assistantMessage: '', metadata: { sourceMessageIds: ['sample'] } }, scope, 'merge-test')
    assert.equal(f.projection.snapshot(), undefined)
    assert.equal((await f.sync()).semanticBundle.openAssertions?.length, 0)
  })
  await test('open-context-vectors-respect-scope-and-do-not-grant-review', async () => {
    const f = fixture(); f.append('样品S7存放在恒温箱B2。', 'sample'); const view = await f.sync()
    const seen: string[] = [], embed = async (text: string) => { seen.push(text); return [1, 0] }
    const own = await searchOpenAssertionsWithContext(view.semanticBundle, '储存位置', { scope, embed })
    assert.equal(own.items.length, 1); assert.equal(own.items[0]!.route, 'context-vector-candidate')
    assert.equal(own.items[0]!.assertion.review.status, 'candidate'); assert.equal(f.extractions.openReviews().length, 0)
    seen.length = 0
    const other = await searchOpenAssertionsWithContext(view.semanticBundle, '储存位置', { scope: { ...scope, ownerId: 'other' }, embed })
    assert.equal(other.items.length, 0); assert.deepEqual(seen, ['储存位置'])
  })
  return { checks }
}
