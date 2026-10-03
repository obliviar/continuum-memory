import assert from 'node:assert/strict'
import { rankL2Seeds, type L2SeedDocument } from '../recall/l2-seed-ranking'
import { createL2HostFixture } from './l2-host-regression'

const scope = { ownerId: 'owner', agentId: 'agent' }
const doc = (id: string, text: string, entityNames: string[] = []): L2SeedDocument =>
  ({ id, factId: id, text, predicate: 'event', entityNames })

/** Synthetic routing checks, not model-quality or semantic entailment tests. */
export async function runL2TargetFilterRegression() {
  const checks: { id: string; passed: boolean; error?: string }[] = []
  const test = async (id: string, action: () => void | Promise<void>) => {
    try { await action(); checks.push({ id, passed: true }) }
    catch (error) { checks.push({ id, passed: false, error: String(error) }) }
  }
  await test('different-events-cannot-pool-their-target-words', () => {
    const r = rankL2Seeds('会议取消', scope,
      [doc('meeting', '会议改期'), doc('game', '比赛取消')], [], 4)
    assert.deepEqual(r.items, [])
    assert.ok(r.scope.includes('seed-anchor-rejected:2'))
    assert.ok(r.scope.includes('seed-abstention:target-anchors-unresolved'))
  })
  await test('dense-score-cannot-override-known-target-anchors', () => {
    const r = rankL2Seeds('会议取消', scope,
      [doc('meeting', '会议改期'), doc('game', '比赛取消')], [{ id: 'game', score: 1 }], 4)
    assert.deepEqual(r.items, [])
  })
  await test('coherent-nonexact-target-survives-before-top-k', () => {
    const r = rankL2Seeds('会议取消', scope,
      [doc('meeting', '会议改期'), doc('game', '比赛取消'), doc('target', '今天会议取消了')],
      [{ id: 'game', score: 1 }, { id: 'target', score: 0.8 }], 1)
    assert.deepEqual(r.items.map(i => i.id), ['target'])
  })
  await test('unseen-paraphrase-keeps-dense-route', () => {
    const r = rankL2Seeds('赛事被叫停', scope, [doc('game', '比赛取消')], [{ id: 'game', score: 0.9 }], 4)
    assert.deepEqual(r.items.map(i => i.id), ['game'])
    assert.ok(r.scope.includes('seed-route:dense'))
  })
  await test('partial-paraphrase-does-not-require-unknown-words', () => {
    const r = rankL2Seeds('公共汽车暂停运营', scope, [doc('bus', '公交停运'), doc('plane', '航班延误')],
      [{ id: 'bus', score: 0.9 }], 4)
    assert.deepEqual(r.items.map(i => i.id), ['bus'])
  })
  await test('predicate-identifiers-cannot-supply-target-evidence', () => {
    const r = rankL2Seeds('会议取消', scope,
      [{ ...doc('meeting', '会议改期'), predicate: '取消' }, doc('game', '比赛取消')], [], 4)
    assert.deepEqual(r.items, [])
  })
  await test('authorized-entity-name-can-supply-target-anchor', () => {
    const r = rankL2Seeds('Alex promotion', scope,
      [doc('target', 'promotion approved', ['Alex']), doc('other', 'promotion approved', ['Bob'])], [], 4)
    assert.deepEqual(r.items.map(i => i.id), ['target'])
  })
  await test('empty-routes-have-distinct-abstention-marker', () => {
    const r = rankL2Seeds('设备故障', scope, [doc('meeting', '会议改期')], [], 4)
    assert.deepEqual(r.items, [])
    assert.ok(r.scope.includes('seed-abstention:no-matching-candidate'))
  })
  await test('zero-budget-is-not-mislabeled-as-no-matching-candidate', () => {
    const r = rankL2Seeds('会议取消', scope, [doc('target', '今天会议取消了')], [], 0)
    assert.deepEqual(r.items, [])
    assert.ok(r.scope.includes('seed-top-k-truncated'))
    assert.ok(!r.scope.some(s => s.startsWith('seed-abstention:')))
  })
  await test('rejected-target-returns-empty-evidence-without-changing-relations', async () => {
    const f = createL2HostFixture()
    f.repository.transaction(s => {
      const fields = { canonicalText: '会议改期', predicate: 'event.meeting', object: '会议改期',
        normalizedValue: '会议改期', evidenceLinkIds: ['ev3'] }
      s.episodes[0]!.content += '会议改期。'
      s.evidenceLinks.push({ ...s.evidenceLinks[0]!, id: 'ev3', factId: 'f3' })
      s.facts.push({ ...s.facts[0]!, ...fields, id: 'f3' })
      s.factVersions.push({ ...s.factVersions[0]!, ...fields, id: 'v3', factId: 'f3' })
    })
    await f.publish()
    const before = f.options.relationPersistence.load(), r = await f.port.recall(f.request('为什么会议取消'))
    assert.ok(r.ok)
    assert.deepEqual(r.value.evidence.claims, [])
    assert.deepEqual(r.value.evidence.relations, [])
    assert.deepEqual(r.value.trace.candidateRefs, [])
    assert.ok(r.value.trace.searchScope.includes('seed-abstention:target-anchors-unresolved'))
    assert.equal(r.value.trace.completeness, 'incomplete')
    assert.equal(f.options.relationPersistence.load(), before)
  })
  return { tests: checks.length, passed: checks.filter(c => c.passed).length, checks }
}
