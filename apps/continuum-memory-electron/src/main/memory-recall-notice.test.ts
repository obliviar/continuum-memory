import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const vue = require('vue'), ts = require('typescript')
const { renderToString } = require('vue/server-renderer')
const { parse, compileScript } = createRequire(require.resolve('vue'))('@vue/compiler-sfc')
const { descriptor } = parse(readFileSync(new URL('../renderer/src/components/MemoryRecallNotice.vue', import.meta.url), 'utf8'))
const compiled = compileScript(descriptor, { id: 'recall-notice-test', inlineTemplate: true })
const code = ts.transpileModule(compiled.content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const module = { exports: {} as any }
new Function('require', 'module', 'exports', code)(require, module, module.exports)
const render = (props = {}) => renderToString(vue.createSSRApp(module.exports.default,
  { enabled: true, memoryEnabled: true, remotePolicy: 'normal-only', busy: false, ...props }))

describe('memory recall permission notice', () => {
  it('distinguishes active raw retrieval from optional Claim publication', async () => {
    const html = await render()
    expect(html).toContain('已开启，无需逐条审核')
    expect(html).toContain('未发布正式事实（L1）不会单独阻止原文召回')
    expect(html).toContain('已开启不代表每条来源都可发送')
    expect(html).not.toContain('<button')
  })
  it('offers an explicit API-sharing authorization without claiming recall is active', async () => {
    const html = await render({ enabled: false })
    expect(html).toContain('尚未授权')
    expect(html).toContain('授权向当前 API 发送普通历史原文并开启召回')
    expect(html).not.toContain('已开启，无需逐条审核')
  })
  it('does not imply that reviewing facts overrides the disabled remote policy', async () => {
    for (const enabled of [true, false]) {
      const html = await render({ enabled, remotePolicy: 'disabled' })
      expect(html).toContain('远程记忆发送已禁用')
      expect(html).not.toContain('<button')
      expect(html).not.toContain('已开启，无需逐条审核')
    }
  })
  it('does not offer authorization while memory is unavailable and disables it while saving', async () => {
    expect(await render({ memoryEnabled: false, enabled: false })).not.toContain('<button')
    expect(await render({ enabled: false, busy: true })).toContain('disabled')
  })
  it('keeps optional formal review sections collapsed and labels UIE privacy separately', () => {
    const app = readFileSync(new URL('../renderer/src/App.vue', import.meta.url), 'utf8')
    for (const field of ['graphReviewItems', 'graphRelationReviewItems', 'graphL2Candidates']) {
      const opening = app.match(new RegExp(`<details v-if="${field}\\.length > 0"[^>]*>`))?.[0]
      expect(opening).toBeDefined()
      expect(opening).not.toMatch(/\bopen\b/)
    }
    expect(app).toContain('此 private 是 UIE 正式事实（L1）的默认本地隔离策略')
    expect(app).not.toContain('原文独立保存，不参与记忆召回')
  })
})
