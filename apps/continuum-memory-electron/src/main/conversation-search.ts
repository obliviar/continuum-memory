import type { ConversationListItem, ConversationSearchResult } from '../shared/chat-ui'
import type { ExportMessage } from '../shared/chat-content'

export function searchConversations(conversations: ConversationListItem[], getMessages: (id: string) => readonly ExportMessage[], query: unknown): ConversationSearchResult[] {
  if (typeof query !== 'string' || query.length > 200) throw new Error('搜索词最多 200 字。')
  const normalize = (text: string) => text.normalize('NFKC').toLocaleLowerCase()
  const terms = normalize(query.trim()).split(/\s+/).filter(Boolean)
  return conversations.flatMap(conversation => {
    if (!terms.length) return [conversation]
    const messages = getMessages(conversation.id).filter(message => message.role === 'user' || message.role === 'assistant')
    const searchable = normalize([conversation.title, ...messages.map(message => `${message.quote?.content ?? ''}\n${message.content}`)].join('\n'))
    if (!terms.every(term => searchable.includes(term))) return []
    const match = messages.find(message => terms.some(term => normalize(message.content).includes(term)))
    if (!match) return [conversation]
    const content = match.content.replace(/\s+/g, ' ')
    const positions = terms.map(term => normalize(content).indexOf(term)).filter(position => position >= 0)
    const offset = Math.max(0, Math.min(...positions) - 28)
    return [{ ...conversation, messageId: match.id, snippet: `${offset ? '…' : ''}${content.slice(offset, offset + 140)}${content.length > offset + 140 ? '…' : ''}` }]
  }).sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned))
}
