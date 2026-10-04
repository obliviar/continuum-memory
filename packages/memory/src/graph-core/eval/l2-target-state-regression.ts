import assert from 'node:assert/strict'
import { rankL2Seeds, type L2SeedDocument } from '../recall/l2-seed-ranking'
import { createL2HostFixture } from './l2-host-regression'

const scope = { ownerId: 'owner', agentId: 'agent' }
const doc = (id: string, text: string, entityNames: string[] = []): L2SeedDocument =>
  ({ id, factId: id, text, predicate: 'event', entityNames })

export async function runL2TargetStateRegression() {
  const checks: { id: string; passed: boolean; error?: string }[] = []
  const test = async (id: string, run: () => void | Promise<void>) => {
    try { await run(); checks.push({ id, passed: true }) }
    catch (error) { checks.push({ id, passed: false, error: String(error) }) }
  }
  for (const [query, candidate] of [
    ['文件上传成功', '文件上传失败'], ['文件上传失败', '文件上传成功'],
    ['设备恢复正常', '设备故障'], ['电梯恢复运行', '电梯停用'],
    ['课程停课', '课程改为线上'], ['预约取消', '预约延期'],
    ['预约延期', '预约取消'], ['设备停用', '设备故障'],
    ['银行扣款失败', '文件上传失败'], ['手机无法充电', '自行车无法骑行'],
  ]) await test(`reject:${query}:${candidate}`, () => {
    assert.deepEqual(rankL2Seeds(query!, scope, [doc('a', candidate!)], [], 4).items, [])
  })
  await test('dense-score-does-not-override-opposite-state', () => {
    const r = rankL2Seeds('导出成功', scope, [doc('a', '图片导出失败')], [{ id: 'a', score: 1 }], 4)
    assert.deepEqual(r.items, []); assert.ok(r.scope.includes('seed-state-rejected:1'))
  })
  await test('generic-inability-in-another-record-does-not-block-a-failure-paraphrase', () => {
    const r = rankL2Seeds('资料无法上传', scope, [doc('file', '文件上传失败'), doc('bike', '自行车无法骑行')], [], 4)
    assert.deepEqual(r.items.map(i => i.id), ['file'])
  })
  await test('unseen-login-inability-paraphrase-shares-an-action', () => {
    const r = rankL2Seeds('账号无法登录', scope, [doc('a', '账号登录失败'), doc('b', '保存失败')], [], 4)
    assert.deepEqual(r.items.map(i => i.id), ['a'])
  })
  await test('failure-rephrasing-keeps-explicit-not-successful', () => {
    const r = rankL2Seeds('图片导出没有成功', scope, [doc('a', '图片导出失败')], [], 4)
    assert.deepEqual(r.items.map(i => i.id), ['a'])
  })
  for (const text of ['没有上传成功', '并非没有上传成功', '如果上传成功', '预计上传成功'])
    await test(`unresolved-state:${text}`, () => {
      const r = rankL2Seeds(text, scope, [doc('a', '上传成功')], [{ id: 'a', score: 1 }], 4)
      assert.deepEqual(r.items, []); assert.ok(r.scope.includes('seed-target-state:ambiguous'))
    })
  for (const text of ['无法恢复正常', '没有恢复正常', '计划恢复正常', '故障后恢复正常'])
    await test(`candidate-is-not-simple-restoration:${text}`, () => {
      assert.deepEqual(rankL2Seeds('恢复正常', scope, [doc('a', text)], [{ id: 'a', score: 1 }], 4).items, [])
    })
  await test('alias-cannot-override-the-claim-state', () => {
    assert.deepEqual(rankL2Seeds('上传成功', scope, [doc('a', '上传失败', ['上传成功'])], [], 4).items, [])
  })
  await test('exact-negated-claim-keeps-its-text-and-identity', () => {
    const r = rankL2Seeds('没有上传成功', scope, [doc('a', '没有上传成功'), doc('b', '上传成功')], [], 4)
    assert.deepEqual(r.items.map(i => i.id), ['a'])
  })
  await test('state-only-query-cannot-use-dense-score-as-an-event', () => {
    assert.deepEqual(rankL2Seeds('失败', scope, [doc('a', '上传失败')], [{ id: 'a', score: 1 }], 4).items, [])
  })
  await test('ordinary-claim-without-a-recognized-state-keeps-existing-behavior', () => {
    const r = rankL2Seeds('生日', scope, [doc('a', '生日聚会')], [], 4)
    assert.deepEqual(r.items.map(i => i.id), ['a'])
  })
  await test('state-filter-happens-before-seed-budget', () => {
    const r = rankL2Seeds('导出成功', scope, [doc('a', '图片导出失败'), doc('b', '图片导出成功了')],
      [{ id: 'a', score: 1 }, { id: 'b', score: 0.9 }], 1)
    assert.deepEqual(r.items.map(i => i.id), ['b'])
  })
  await test('real-traversal-keeps-failure-evidence-and-rejects-success-premise', async () => {
    const f = createL2HostFixture()
    f.repository.transaction(s => {
      s.episodes[0]!.content = '网络故障导致文件上传失败。'
      for (const row of [...s.facts, ...s.factVersions]) {
        const text = ('factId' in row ? row.factId : row.id) === 'f2' ? '文件上传失败' : '网络故障'
        Object.assign(row, { canonicalText: text, object: text, normalizedValue: text })
      }
    })
    await f.publish(['causes']); const before = f.options.relationPersistence.load()
    for (const [query, count] of [['为什么资料无法上传', 2], ['为什么文件上传成功', 0]] as const) {
      const r = await f.port.recall(f.request(query)); assert.ok(r.ok)
      assert.equal(r.value.evidence.claims.length, count)
      assert.equal(r.value.evidence.relations!.length, count ? 1 : 0)
      assert.equal(r.value.trace.completeness, 'incomplete')
    }
    assert.equal(f.options.relationPersistence.load(), before)
  })
  return { tests: checks.length, passed: checks.filter(c => c.passed).length, checks }
}
