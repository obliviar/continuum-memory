import assert from 'node:assert/strict'
import type { GraphRecallResult, GraphResult } from '@continuum-memory/contracts'
import type { GraphRelationRecord } from '../domain/relation-types'
import { createL2HostFixture } from './l2-host-regression'

const value = <T>(r: GraphResult<T>): T => { if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`); return r.value }

/** Upstream-style published records are test inputs, never automatically extracted relationships. */
async function fixture(cycle = false) {
  const f = createL2HostFixture(), texts = ['暴雨', '道路积水', '公交停运', '设备故障', '行程取消']
  f.repository.transaction(s => {
    const fact = s.facts[0]!, version = s.factVersions[0]!, link = s.evidenceLinks[0]!
    s.episodes[0]!.content = '暴雨导致道路积水，道路积水导致公交停运，设备故障也导致公交停运。公交停运在行程取消之前。'
      + (cycle ? '合成循环测试：公交停运又导致道路积水。' : '')
    s.facts = texts.map((text, i) => ({ ...fact, id: `event-${i}`, predicate: `event.${i}`, memoryKey: `event.${i}`,
      canonicalText: text, object: text, normalizedValue: text, evidenceLinkIds: [`source-${i}`] }))
    s.factVersions = texts.map((text, i) => ({ ...version, id: `version-${i}`, factId: `event-${i}`, predicate: `event.${i}`,
      canonicalText: text, object: text, normalizedValue: text, evidenceLinkIds: [`source-${i}`] }))
    s.evidenceLinks = texts.map((_, i) => ({ ...link, id: `source-${i}`, factId: `event-${i}` }))
  })
  const request = (query = '为什么公交停运', maxHops = 2) => {
    const req = f.request(query)
    return { ...req, budget: { ...req.budget, maxSeeds: 1, maxHops } }
  }
  const prepared = value(f.port.prepareRelations(request().scope)), snapshot = prepared.repository.snapshot()
  const claims = texts.map((_, i) => prepared.core.l1.snapshot()!.semanticBundle.claims.find(c => c.fact.id === `event-${i}`)!)
  const edges: [number, number, GraphRelationRecord['kind']][] = [[0, 1, 'causes'], [1, 2, 'causes'], [2, 4, 'precedes']]
  if (!cycle) edges.push([3, 2, 'causes'])
  if (cycle) edges.push([2, 1, 'causes'])
  const relations: GraphRelationRecord[] = edges.map(([from, to, kind], i) => ({
    ref: { kind: 'relation', id: `reviewed-edge-${i}`, version: 1 }, from: claims[from]!.ref, to: claims[to]!.ref,
    kind, context: claims[from]!.context, scope: request().scope, polarity: 'positive', modality: 'asserted',
    validTime: { kind: 'interval', from: 100, to: null }, assertionBasis: 'source-explicit',
    transactionTime: { recordedAt: 100, closedAt: null }, review: { status: 'accepted', reviewedAt: 100, reviewer: 'synthetic-fixture' },
    provenance: claims[from]!.provenance, evidence: [{ source: claims[from]!.provenance.sources[0]!, role: 'supports' }],
    sensitivity: 'normal', sharePolicy: 'local-only', nliObservationIds: [],
  }))
  value(await prepared.repository.publish({ operationId: 'explanation-fixture', expectedManifestId: snapshot.manifest.manifestId,
    snapshot: { ...snapshot, manifest: { ...snapshot.manifest, manifestId: 'explanation-fixture', relationRevision: 1 }, relations } }))
  return { ...f, request, texts }
}

export async function runL2RecallExplanationRegression(prompt: (result: GraphRecallResult) => string) {
  const checks: { id: string; passed: boolean; error?: string }[] = []
  const test = async (id: string, action: () => Promise<void>) => {
    try { await action(); checks.push({ id, passed: true }) }
    catch (error) { checks.push({ id, passed: false, error: String(error) }) }
  }
  await test('incoming-two-hop-path-and-competing-causes-reach-agent', async () => {
    const f = await fixture(), result = value(await f.port.recall(f.request())), context = result.evidence.relationRecall!
    assert.equal(result.evidence.claims.length, 4); assert.equal(result.evidence.relations!.length, 3)
    assert.equal(context.direction, 'in'); assert.deepEqual(context.kinds, ['causes'])
    assert.equal(context.paths.length, 4); assert.equal(Math.max(...context.paths.map(p => p.depth)), 2)
    const target = result.evidence.claims.find(c => c.content === '公交停运')!
    const alternatives = context.causalAlternatives.find(a => a.target.id === target.ref.id)!
    assert.equal(alternatives.causes.length, 2); assert.equal(alternatives.hasMultipleCauses, true)
    assert.equal(alternatives.coverage, 'complete-within-declared-scope')
    assert.equal(context.conflictAudit, 'not-supported'); assert.equal(result.trace.completeness, 'incomplete')
    assert.equal(result.evidence.proofs.length, 0)
    const text = prompt(result); assert.ok(text.includes('"paths"')); assert.ok(text.includes('"hasMultipleCauses":true'))
    const rain = result.evidence.claims.find(c => c.content === '暴雨')!
    assert.ok(!result.evidence.relations!.some(r => r.from.id === rain.ref.id && r.to.id === target.ref.id))
  })
  await test('outgoing-traversal-does-not-pull-in-another-cause', async () => {
    const f = await fixture(), result = value(await f.port.recall(f.request('暴雨导致什么')))
    assert.deepEqual(result.evidence.claims.map(c => c.content), ['暴雨', '道路积水', '公交停运'])
    assert.equal(result.evidence.relations!.length, 2)
    assert.ok(result.evidence.relationRecall!.causalAlternatives.every(a => a.coverage === 'not-checked'))
    prompt(result)
  })
  await test('one-hop-frontier-is-explicit-and-excludes-distant-cause', async () => {
    const f = await fixture(), result = value(await f.port.recall(f.request(undefined, 1)))
    assert.equal(result.evidence.claims.length, 3)
    assert.ok(!result.evidence.claims.some(c => c.content === '暴雨'))
    assert.equal(result.evidence.relationRecall!.depthFrontier.length, 2)
    assert.equal(result.trace.stopReason, 'hop-budget'); prompt(result)
  })
  await test('zero-hop-keeps-only-target-and-unchecked-frontier', async () => {
    const f = await fixture(), result = value(await f.port.recall(f.request(undefined, 0)))
    assert.equal(result.evidence.claims.length, 1); assert.equal(result.evidence.relations!.length, 0)
    assert.equal(result.evidence.relationRecall!.depthFrontier.length, 1)
    assert.ok(result.evidence.relationRecall!.causalAlternatives.every(a => a.coverage === 'not-checked')); prompt(result)
  })
  await test('time-question-preserves-precedes-without-causal-upgrade', async () => {
    const f = await fixture(), result = value(await f.port.recall(f.request('公交停运之后发生了什么')))
    assert.deepEqual(result.evidence.relations!.map(r => r.kind), ['precedes'])
    assert.equal(result.evidence.claims.length, 2); prompt(result)
  })
  await test('no-cause-found-does-not-claim-conflict-audit-complete', async () => {
    const f = await fixture(), result = value(await f.port.recall(f.request('为什么行程取消')))
    assert.equal(result.evidence.relations!.length, 0); assert.equal(result.evidence.relationRecall!.conflictAudit, 'not-supported')
    assert.equal(result.trace.completeness, 'incomplete'); prompt(result)
  })
  await test('cycle-does-not-create-duplicate-paths-or-transitive-proof', async () => {
    const f = await fixture(true), result = value(await f.port.recall(f.request()))
    assert.equal(result.evidence.relationRecall!.paths.length, 3)
    assert.equal(result.evidence.relations!.length, 3); assert.equal(result.evidence.proofs.length, 0); prompt(result)
  })
  await test('explanation-counts-towards-budget-without-silent-truncation', async () => {
    const f = await fixture(), request = f.request(), full = value(await f.port.recall(request))
    const limited = await f.port.recall({ ...request, budget: { ...request.budget,
      maxEvidenceTokens: full.trace.usage.evidenceTokens + 2048 - 1 } })
    assert.equal(limited.ok, false)
    if (!limited.ok) assert.equal(limited.error.code, 'budget-exhausted')
  })
  for (const mutation of ['missing-relation', 'wrong-depth', 'reverse-direction', 'duplicate-path', 'missing-frontier', 'fake-cause-count', 'hidden-cause'] as const)
    await test(`reject-explanation:${mutation}`, async () => {
      const f = await fixture(), result = value(await f.port.recall(f.request()))
      const context = structuredClone(result.evidence.relationRecall!)
      const child = context.paths.find(p => p.depth > 0)!
      if (mutation === 'missing-relation') Reflect.set(child, 'via', { kind: 'relation', id: 'not-returned', version: 1 })
      if (mutation === 'wrong-depth') Reflect.set(child, 'depth', 2)
      if (mutation === 'reverse-direction') Reflect.set(context, 'direction', 'out')
      if (mutation === 'duplicate-path') Reflect.set(context, 'paths', [...context.paths, context.paths[0]])
      if (mutation === 'missing-frontier') Reflect.set(context, 'depthFrontier', [])
      if (mutation === 'fake-cause-count') Reflect.set(context.causalAlternatives.find(a => a.hasMultipleCauses)!, 'hasMultipleCauses', false)
      if (mutation === 'hidden-cause') {
        const alternative = context.causalAlternatives.find(a => a.hasMultipleCauses)!
        Reflect.set(alternative, 'causes', alternative.causes.slice(0, 1)); Reflect.set(alternative, 'hasMultipleCauses', false)
      }
      assert.throws(() => prompt({ ...result, evidence: { ...result.evidence, relationRecall: context } }), /retrieval explanation/)
    })
  return { tests: checks.length, passed: checks.filter(c => c.passed).length, checks }
}
