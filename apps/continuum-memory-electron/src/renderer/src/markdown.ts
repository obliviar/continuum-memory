import MarkdownIt from 'markdown-it'
import hljs from 'highlight.js/lib/core'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import python from 'highlight.js/lib/languages/python'
import json from 'highlight.js/lib/languages/json'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import xml from 'highlight.js/lib/languages/xml'
import sql from 'highlight.js/lib/languages/sql'

for (const [name, grammar] of Object.entries({ javascript, typescript, python, json, bash, css, xml, sql })) hljs.registerLanguage(name, grammar)

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true })
interface RenderEnvironment extends Record<PropertyKey, unknown> { blocks: string[] }
markdown.renderer.rules.fence = (tokens, index, _options, environment) => {
  const token = tokens[index]!
  const language = token.info.trim().split(/\s+/)[0] || 'text'
  const env = environment as unknown as RenderEnvironment
  const codeIndex = env.blocks.push(token.content) - 1
  let html = markdown.utils.escapeHtml(token.content)
  if (hljs.getLanguage(language)) {
    try { html = hljs.highlight(token.content, { language, ignoreIllegals: true }).value } catch { /* Plain code remains readable. */ }
  }
  return `<div class="markdown-code"><div class="markdown-code-heading"><span>${markdown.utils.escapeHtml(language)}</span><button type="button" data-code-index="${codeIndex}" aria-label="复制代码">复制代码</button></div><pre><code>${html}</code></pre></div>`
}
markdown.renderer.rules.table_open = () => '<div class="markdown-table"><table>'
markdown.renderer.rules.table_close = () => '</table></div>'
// A model-provided image URL must not cause an automatic network request.
markdown.renderer.rules.image = (tokens, index) => `<span class="markdown-image-label">[图片：${markdown.utils.escapeHtml(tokens[index]!.content || '图片')}]</span>`

export function renderMarkdown(content: string): { html: string; blocks: string[] } {
  const environment: RenderEnvironment = { blocks: [] }
  return { html: markdown.render(content, environment), blocks: environment.blocks }
}
