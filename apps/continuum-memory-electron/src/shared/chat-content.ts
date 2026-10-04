import MarkdownIt from 'markdown-it'
import type { MessageQuote } from './chat-ui'

const markdown = new MarkdownIt({ html: false, breaks: true, linkify: true })

/** Text from visible Markdown tokens, never from executable HTML. */
export function markdownPlainText(content: string): string {
  const tokens = markdown.parse(content, {})
  const parts: string[] = []
  for (const token of tokens) {
    if (token.type === 'inline') {
      for (const child of token.children ?? []) {
        if (['text', 'code_inline', 'html_inline'].includes(child.type)) parts.push(child.content)
        else if (child.type === 'softbreak' || child.type === 'hardbreak') parts.push('\n')
        else if (child.type === 'image') parts.push(child.content)
      }
    } else if (token.type === 'fence' || token.type === 'code_block') parts.push(token.content)
    else if (token.block && token.nesting === -1) parts.push('\n')
  }
  return parts.join('').replace(/\n{3,}/g, '\n\n').trim()
}

export interface ExportMessage {
  status?: 'failed' | 'stopped'
  id: string
  role: string
  content: string
  quote?: MessageQuote
}

export function validateMessageQuote(value: unknown, messages: readonly ExportMessage[]): MessageQuote | undefined {
  if (value === undefined || value === null) return undefined
  if (!value || typeof value !== 'object') throw new Error('引用消息格式不正确。')
  const quote = value as Partial<MessageQuote>
  const source = messages.find(message => message.id === quote.messageId && (message.role === 'user' || message.role === 'assistant'))
  if (!source || quote.role !== source.role || typeof quote.content !== 'string' || !quote.content.trim() || quote.content.length > 12000)
    throw new Error('引用消息已失效，请重新选择需要引用的内容。')
  const normalize = (text: string) => text.normalize('NFKC').replace(/\s/g, '')
  // A formatted selection can omit Markdown markers, list markers or table spacing.
  const excerpt = normalize(quote.content)
  if (!normalize(source.content).includes(excerpt) && !normalize(markdownPlainText(source.content)).includes(excerpt))
    throw new Error('引用内容与原消息不一致，请重新选择。')
  return { messageId: source.id, role: source.role as MessageQuote['role'], content: quote.content }
}

export function buildConversationExport(title: string, messages: readonly ExportMessage[], format: 'md' | 'txt', assistantName: string): string {
  const sections = [format === 'md' ? `# ${title.replace(/[\r\n]/g, ' ')}` : title]
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue
    const role = message.role === 'user' ? '你' : assistantName
    const content = message.content + (message.status ? `${message.content ? '\n\n' : ''}[${message.status === 'stopped' ? '已停止生成' : '请求失败'}]` : '')
    const quote = message.quote ? `引用${message.quote.role === 'user' ? '你的消息' : '回答'}：\n${message.quote.content}` : ''
    sections.push(format === 'md'
      ? `## ${role}\n\n${quote ? quote.split('\n').map(line => `> ${line}`).join('\n') + '\n\n' : ''}${content}`
      : `${role}\n${quote ? quote + '\n\n' : ''}${markdownPlainText(content)}`)
  }
  return sections.join('\n\n') + '\n'
}

export function exportFilename(title: string): string {
  let name = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 80).replace(/[.\s]+$/g, '')
  if (!name || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `对话_${name || '记录'}`
  return name
}
