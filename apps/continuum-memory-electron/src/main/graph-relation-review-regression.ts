import assert from 'node:assert/strict'
import { createGraphRelationReviewController } from './graph-relation-review-controller'
import { createL2HostFixture } from '../../../../packages/memory/src/graph-core/eval/l2-host-regression'
import { createV4L2Memory } from '../../../../packages/memory/src/graph-core/adapters/v4-l2-memory'
import { V4_TEST_SCOPE as scope } from '../../../../packages/memory/src/graph-core/fixtures/v4-direct-memory'

export async function runDesktopGraphReviewRegression() {
  const checks: { id: string; passed: boolean; error?: string }[] = []
  async function test(id: string, run: () => Promise<void>) {
    try { await run(); checks.push({ id, passed: true }) }
    catch (error) { checks.push({ id, passed: false, error: String(error) }) }
  }
  async function fixture() {
    const f = createL2HostFixture(); await f.publish()
    f.repository.transaction(s => { s.facts[0]!.accessCount++ })
    let failFlush = false
    const controller = createGraphRelationReviewController({ scope, createPort: () => createV4L2Memory(f.options),
      flush: () => { if (failFlush) throw new Error('private error data') }, graphEnabled: () => false })
    return { ...f, controller, failFlush: () => { failFlush = true } }
  }
  const confirm = (reviewId: string | null) => ({ reviewId, reason: '已检查关系含义和方向。', confirmed: true })
  await test('desktop-preview-confirm-uses-fixed-host-identity-and-preserves-mode', async () => {
    const f = await fixture(), r = await f.controller.preview(); assert.ok(r.ok)
    assert.equal(r.report.relations[0]!.fromText, '下雨')
    assert.equal(JSON.parse(f.options.relationPersistence.load()!).manifest.state, 'stale')
    const result = await f.controller.confirm(confirm(r.report.reviewId)); assert.ok(result.ok)
    assert.equal(result.graphEnabled, false)
    assert.equal(JSON.parse(f.options.relationPersistence.load()!).lastRevalidation.reviewer, 'desktop-local-user')
  })
  await test('renderer-cannot-override-scope-reviewer-or-skip-confirmation', async () => {
    const f = await fixture(), r = await f.controller.preview(); assert.ok(r.ok)
    for (const input of [null, {}, { ...confirm(r.report.reviewId), scope: { ownerId: 'other' } },
      { ...confirm(r.report.reviewId), reviewer: 'other' }, { ...confirm(r.report.reviewId), confirmed: false },
      { ...confirm(r.report.reviewId), reason: '' }]) assert.equal((await f.controller.confirm(input)).ok, false)
    assert.equal(JSON.parse(f.options.relationPersistence.load()!).manifest.state, 'stale')
    assert.equal((await f.controller.confirm(confirm(r.report.reviewId))).ok, true)
  })
  await test('refresh-and-reset-revoke-previous-desktop-report', async () => {
    const f = await fixture(), first = await f.controller.preview(); assert.ok(first.ok)
    const second = await f.controller.preview(); assert.ok(second.ok)
    assert.equal((await f.controller.confirm(confirm(first.report.reviewId))).ok, false)
    f.controller.reset()
    assert.equal((await f.controller.confirm(confirm(second.report.reviewId))).ok, false)
  })
  await test('reset-during-preview-cannot-reinstall-old-token', async () => {
    const f = await fixture(), task = f.controller.preview(); f.controller.reset()
    assert.equal((await task).ok, false)
    assert.equal((await f.controller.confirm(confirm('unknown'))).ok, false)
  })
  await test('desktop-confirmation-detects-source-update-and-requires-new-report', async () => {
    const f = await fixture(), r = await f.controller.preview(); assert.ok(r.ok)
    f.repository.transaction(s => { s.episodes[0]!.content += '变化。' })
    const result = await f.controller.confirm(confirm(r.report.reviewId)); assert.equal(result.ok, false)
    if (!result.ok) assert.ok(result.error.includes('重新查看'))
    assert.equal((await f.controller.confirm(confirm(r.report.reviewId))).ok, false)
  })
  await test('blocked-relations-have-readable-reasons-and-no-confirmation-token', async () => {
    const f = await fixture(); f.repository.transaction(s => { s.episodes[0]!.content += '变化。' })
    const r = await f.controller.preview(); assert.ok(r.ok)
    assert.equal(r.report.canPublish, false); assert.equal(r.report.reviewId, null)
    assert.ok(r.report.blockers.some(message => message.includes('原来的事实版本')))
  })
  await test('desktop-concurrent-confirmation-publishes-once', async () => {
    const f = await fixture(), r = await f.controller.preview(); assert.ok(r.ok)
    const results = await Promise.all([f.controller.confirm(confirm(r.report.reviewId)), f.controller.confirm(confirm(r.report.reviewId))])
    assert.equal(results.filter(result => result.ok).length, 1)
  })
  await test('flush-failure-blocks-publish-and-does-not-expose-exception-text', async () => {
    const f = await fixture(), r = await f.controller.preview(); assert.ok(r.ok); f.failFlush()
    const result = await f.controller.confirm(confirm(r.report.reviewId)); assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.error.includes('private error data'), false)
    assert.equal(JSON.parse(f.options.relationPersistence.load()!).manifest.state, 'stale')
  })
  await test('unavailable-memory-has-a-readable-error', async () => {
    const controller = createGraphRelationReviewController({ scope, createPort: () => undefined, flush: () => {}, graphEnabled: () => true })
    const r = await controller.preview(); assert.equal(r.ok, false)
    if (!r.ok) assert.ok(r.error.includes('尚未就绪'))
  })
  for (const phase of ['preview', 'confirm'] as const) await test(`reset-during-async-flush-blocks-${phase}`, async () => {
    const f = await fixture()
    let blocking = false, release!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    const controller = createGraphRelationReviewController({ scope, createPort: () => createV4L2Memory(f.options),
      flush: async () => { if (blocking) await barrier }, graphEnabled: () => true })
    const report = await controller.preview(); assert.ok(report.ok)
    const before = f.options.relationPersistence.load()
    blocking = true
    const pending = phase === 'preview' ? controller.preview() : controller.confirm(confirm(report.report.reviewId))
    controller.reset(); release()
    assert.equal((await pending).ok, false)
    assert.equal(f.options.relationPersistence.load(), before)
  })
  return { kind: 'desktop-controller-through-real-review-service-with-synthetic-memory', checks }
}
