// Headless interaction test of the actual compiled Vue component; no Electron or user data.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(new URL('../../package.json', import.meta.url))
const vue = require('vue'), ts = require('typescript')
const { parse, compileScript } = createRequire(require.resolve('vue'))('@vue/compiler-sfc')
const file = new URL('../renderer/src/components/GraphRelationReview.vue', import.meta.url)
const { descriptor } = parse(readFileSync(file, 'utf8'))
const compiled = compileScript(descriptor, { id: 'review-test', inlineTemplate: true })
const code = ts.transpileModule(compiled.content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const priorDocument = globalThis.document, priorDocumentClass = globalThis.Document
globalThis.Document = class { activeElement = null }
globalThis.document = new globalThis.Document()
function node(type, text = '') {
  return { type, tagName: type.toUpperCase(), text, children: [], props: {}, parent: null,
    addEventListener() {}, removeEventListener() {}, setAttribute() {}, removeAttribute() {}, getRootNode: () => globalThis.document }
}
const renderer = vue.createRenderer({
  createElement: type => node(type), createText: text => node('#text', text), createComment: text => node('#comment', text),
  setText: (n, text) => { n.text = text }, setElementText: (n, text) => { n.text = text; n.children = [] },
  parentNode: n => n.parent, nextSibling: n => n.parent?.children[n.parent.children.indexOf(n) + 1] ?? null,
  patchProp: (n, key, _old, value) => { n.props[key] = value; if (key === 'value') n.value = value },
  insert(n, parent, anchor = null) {
    if (n.parent) n.parent.children.splice(n.parent.children.indexOf(n), 1)
    n.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1
    if (index < 0) parent.children.push(n); else parent.children.splice(index, 0, n)
  },
  remove(n) { if (n.parent) n.parent.children.splice(n.parent.children.indexOf(n), 1); n.parent = null },
})
function all(n) { return [n, ...n.children.flatMap(all)] }
function text(n) { return n.type === '#comment' ? '' : n.text + n.children.map(text).join('') }
const baseReport = { reviewId: 'test-token', expiresAt: Date.now() + 300000, canPublish: true,
  candidateCount: 0, observationCount: 0, blockers: [], relations: [
    { id: 'r', kind: 'causes', fromText: '<script>不应执行</script>', toText: '比赛取消', eligible: true, reasons: [] },
  ] }
const checks = []
async function test(id, response, action) {
  const calls = [], root = node('root'), module = { exports: {} }
  new Function('require', 'module', 'exports', 'window', code)(require, module, module.exports,
    { require: () => ({ ipcRenderer: { invoke: async (channel, payload) => {
      calls.push({ channel, payload }); return channel.endsWith('preview') ? response : { ok: true, graphEnabled: false }
    } } }) })
  const app = renderer.createApp(module.exports.default); app.mount(root)
  try {
    const find = (type, label) => all(root).find(n => n.type === type && (!label || text(n).includes(label)))
    await find('button', '查看复核报告').props.onClick(); await vue.nextTick()
    await action({ root, find, calls }); checks.push({ id, passed: true })
  } catch (error) { checks.push({ id, passed: false, error: String(error) }) }
  finally { app.unmount() }
}
try {
  await test('confirmation-needs-checkbox-and-explanation', { ok: true, graphEnabled: false, report: baseReport }, async ({ find, calls, root }) => {
    assert.equal(find('button', '确认重新发布').props.disabled, true)
    find('textarea').props['onUpdate:modelValue']('已检查'); await vue.nextTick()
    assert.equal(find('button', '确认重新发布').props.disabled, true)
    find('input').props['onUpdate:modelValue'](true); await vue.nextTick()
    assert.equal(find('button', '确认重新发布').props.disabled, false)
    await find('button', '确认重新发布').props.onClick(); await vue.nextTick()
    assert.deepEqual(calls[1], { channel: 'memory:graph-review-confirm', payload: { reviewId: 'test-token', reason: '已检查', confirmed: true } })
    assert.ok(text(root).includes('关系已重新发布')); assert.equal(find('textarea'), undefined)
  })
  await test('memory-text-is-rendered-as-text', { ok: true, graphEnabled: true, report: baseReport }, async ({ root, find }) => {
    assert.ok(text(root).includes('<script>不应执行</script>')); assert.equal(find('script'), undefined)
  })
  await test('blocked-report-has-no-publish-control', { ok: true, graphEnabled: true,
    report: { ...baseReport, canPublish: false, reviewId: null, blockers: ['来源已变化'] } }, async ({ root, find }) => {
    assert.ok(text(root).includes('来源已变化')); assert.equal(find('button', '确认重新发布'), undefined)
  })
  await test('expired-report-disables-publication', { ok: true, graphEnabled: true,
    report: { ...baseReport, expiresAt: Date.now() - 1 } }, async ({ root, find }) => {
    assert.ok(text(root).includes('报告已过期')); assert.equal(find('button', '确认重新发布').props.disabled, true)
  })
  await test('empty-report-explains-that-no-relations-are-created', { ok: true, graphEnabled: false,
    report: { ...baseReport, relations: [] } }, async ({ root, find }) => {
    assert.ok(text(root).includes('没有可供复核的已采纳关系')); assert.equal(find('button', '确认重新发布'), undefined)
  })
  await test('preview-failure-is-visible', { ok: false, error: '记忆仓库尚未就绪' }, async ({ root, find }) => {
    assert.ok(text(root).includes('记忆仓库尚未就绪')); assert.equal(find('button', '确认重新发布'), undefined)
  })
} finally { globalThis.document = priorDocument; globalThis.Document = priorDocumentClass }
console.log(JSON.stringify({ kind: 'compiled-vue-headless-interactions-not-Electron-visual-QA', checks }, null, 2))
if (checks.some(check => !check.passed)) process.exitCode = 1
