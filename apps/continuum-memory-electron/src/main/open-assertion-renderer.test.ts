import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

// Compile and interact with the real Vue component using a headless renderer.
const require = createRequire(import.meta.url)
const vue = require('vue'), ts = require('typescript')
const { parse, compileScript } = createRequire(require.resolve('vue'))('@vue/compiler-sfc')
const { descriptor } = parse(readFileSync(new URL('../renderer/src/components/GraphOpenAssertions.vue', import.meta.url), 'utf8'))
const compiled = compileScript(descriptor, { id: 'open-graph-test', inlineTemplate: true })
const code = ts.transpileModule(compiled.content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
function node(type: string, text = ''): any {
  return { type, tagName: type.toUpperCase(), text, children: [], props: {}, parent: null,
    get options(): any[] { return this.children.filter((child: any) => child.type === 'option') },
    addEventListener() {}, removeEventListener() {}, setAttribute() {}, removeAttribute() {}, getRootNode: () => globalThis.document }
}
function all(n: any): any[] { return [n, ...n.children.flatMap(all)] }
function text(n: any): string { return n.type === '#comment' ? '' : n.text + n.children.map(text).join('') }

async function fixture(invoke: (channel: string, input: any) => Promise<any>, action: (find: (type: string, label?: string) => any, root: any, events: string[]) => Promise<void>) {
  const priorDocument = globalThis.document, priorDocumentClass = globalThis.Document
  ;(globalThis as any).Document = class { activeElement = null }
  ;(globalThis as any).document = new globalThis.Document()
  const renderer = vue.createRenderer({
    createElement: (type: string) => node(type), createText: (value: string) => node('#text', value), createComment: (value: string) => node('#comment', value),
    setText: (n: any, value: string) => { n.text = value }, setElementText: (n: any, value: string) => { n.text = value; n.children = [] },
    parentNode: (n: any) => n.parent, nextSibling: (n: any) => n.parent?.children[n.parent.children.indexOf(n) + 1] ?? null,
    patchProp: (n: any, key: string, _old: unknown, value: unknown) => { n.props[key] = value; if (key === 'value') n.value = value },
    insert(n: any, parent: any, anchor: any = null) {
      if (n.parent) n.parent.children.splice(n.parent.children.indexOf(n), 1)
      n.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1
      if (index < 0) parent.children.push(n); else parent.children.splice(index, 0, n)
    },
    remove(n: any) { if (n.parent) n.parent.children.splice(n.parent.children.indexOf(n), 1); n.parent = null },
  })
  const module = { exports: {} as any }, root = node('root'), events: string[] = []
  new Function('require', 'module', 'exports', 'window', code)(require, module, module.exports,
    { require: () => ({ ipcRenderer: { invoke: async (channel: string, input: unknown) => invoke(channel, structuredClone(input)) } }) })
  const app = renderer.createApp(module.exports.default, { ready: true, busy: false,
    items: [{ ref: { id: 'assertion' }, extraction: { sourceRevision: 'revision' }, relationText: '存放在',
      text: '<script>样品S7存放在恒温箱B2</script>', participants: [{ ref: { id: 'mention' }, role: 'subject', text: '样品S7', typeCandidate: 'unknown' }],
      attributes: [], review: { status: 'candidate' } }], sources: [{ id: 'information', sourceId: 'capture', text: '原文' }],
    onRefresh: () => events.push('refresh') })
  const find = (type: string, label?: string) => all(root).find(n => n.type === type && (!label || text(n).includes(label)))
  try { app.mount(root); await action(find, root, events) }
  finally { app.unmount(); globalThis.document = priorDocument; globalThis.Document = priorDocumentClass }
}

describe('open graph desktop controls', () => {
  it('submits a clonable confirmation and refreshes the list after success', async () => {
    const calls: any[] = []
    await fixture(async (channel, input) => { calls.push({ channel, input }); return { ok: true } }, async (find, root, events) => {
      expect(find('script')).toBeUndefined()
      expect(text(root)).toContain('<script>样品S7')
      await find('button', '确认与原文一致').props.onClick()
      await vue.nextTick()
      expect(calls[0]).toMatchObject({ channel: 'memory:graph-open-review', input: { id: 'assertion', outcome: 'accepted', sourceRevision: 'revision' } })
      expect(events).toEqual(['refresh'])
      expect(text(root)).toContain('已确认开放断言')
    })
  })

  it('shows a backend review failure without displaying false success or emitting refresh', async () => {
    await fixture(async () => ({ ok: false, error: '来源版本已变化' }), async (find, root, events) => {
      await find('button', '确认与原文一致').props.onClick(); await vue.nextTick()
      expect(text(root)).toContain('来源版本已变化')
      expect(text(root)).not.toContain('已确认开放断言')
      expect(events).toEqual([])
    })
  })

  it('searches and explains mention-based neighbors without asserting entity equality', async () => {
    const calls: any[] = []
    await fixture(async (channel, input) => { calls.push({ channel, input }); return { ok: true,
      items: [{ assertion: { ref: { id: 'neighbor' }, text: '恒温箱B2发生故障' }, depth: 1, via: { mentionText: '恒温箱B2' } }], sources: [] } },
    async (find, root) => {
      find('input').props['onUpdate:modelValue']('样品S7'); await vue.nextTick()
      await find('button', '搜索相关开放记忆').props.onClick(); await vue.nextTick()
      expect(calls[0]).toEqual({ channel: 'memory:graph-open-search', input: { query: '样品S7', maximumDepth: 2, includeCandidates: false } })
      expect(text(root)).toContain('恒温箱B2发生故障')
      expect(text(root)).toContain('同名不等于同一实体')
    })
  })

  it('allows explicit unverified-candidate search and labels semantic ranking without treating it as approval', async () => {
    const calls: any[] = []
    await fixture(async (channel, input) => { calls.push({ channel, input }); return { ok: true,
      semantic: { mode: 'context-vector', compared: 2, truncated: false },
      items: [{ assertion: { ref: { id: 'uncertain' }, text: '如果设备修好，样品S7存放在恒温箱B2',
        sourceContext: { text: '小王说：如果设备修好，样品S7存放在恒温箱B2' }, review: { status: 'candidate' } },
      depth: 0, route: 'context-vector-candidate', verification: 'unverified-candidate' }] } }, async (find, root) => {
      const checkbox = all(root).find(n => n.type === 'input' && n.props.type === 'checkbox')
      checkbox.props['onUpdate:modelValue'](true)
      find('input').props['onUpdate:modelValue']('样品S7'); await vue.nextTick()
      await find('button', '搜索相关开放记忆').props.onClick(); await vue.nextTick()
      expect(calls[0]?.input.includeCandidates).toBe(true)
      expect(text(root)).toContain('未核实候选')
      expect(text(root)).toContain('相似度仅表示相关性')
      expect(text(root)).toContain('小王说')
      expect(find('button', '按需确认')).toBeDefined()
    })
  })

  it('submits a new domain target and source using the real custom-extraction button', async () => {
    const calls: any[] = []
    await fixture(async (channel, input) => { calls.push({ channel, input }); return { ok: true } }, async (find, root, events) => {
      find('select').props['onUpdate:modelValue']('capture')
      const inputs = all(root).filter(n => n.type === 'input' && n.props.type !== 'checkbox')
      inputs[1]!.props['onUpdate:modelValue']('设备→故障'); await vue.nextTick()
      await find('button', '本地重新提取').props.onClick(); await vue.nextTick()
      expect(calls[0]).toEqual({ channel: 'memory:graph-custom-extract', input: { sourceId: 'capture', targets: '设备→故障' } })
      expect(events).toEqual(['refresh'])
    })
  })
})
