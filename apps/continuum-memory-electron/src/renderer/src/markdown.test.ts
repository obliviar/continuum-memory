import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './markdown'
import { markdownPlainText } from '../../shared/chat-content'

describe('desktop Markdown rendering', () => {
  it('renders tables and nested lists and copies the exact fenced code', () => {
    const code = 'const label = "<你好>";\n'
    const content = `# 标题\n\n- 主项\n  - 子项\n\n| 名称 | 数量 |\n| --- | --- |\n| A | 2 |\n\n\`\`\`javascript\n${code}\`\`\``
    const rendered = renderMarkdown(content)
    expect(rendered.html).toContain('<h1>标题</h1>')
    expect(rendered.html).toContain('<table>')
    expect(rendered.html).toContain('<ul>')
    expect(rendered.blocks).toEqual([code])
    expect(markdownPlainText('我**喜欢**这个方案。')).toBe('我喜欢这个方案。')
  })
  it('escapes model HTML, blocks executable URLs and does not fetch remote images', () => {
    const rendered = renderMarkdown('<img src=x onerror="require(\'node:fs\')">\n\n[危险](javascript:alert(1))\n\n![图片](https://example.com/tracker.png)\n\n```bad\" onclick=\"evil\n<script>evil()</script>\n```').html
    expect(rendered).not.toMatch(/<img\b|<script\b|href="javascript:|onclick="evil/)
    expect(rendered).toContain('&lt;img')
    expect(rendered).toContain('markdown-image-label')
  })
})
