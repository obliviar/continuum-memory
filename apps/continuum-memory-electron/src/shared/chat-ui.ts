export interface MessageQuote {
  messageId: string
  role: 'user' | 'assistant'
  content: string
}

export interface ChatDraft {
  text: string
  quote?: MessageQuote
  skillId?: string
}

export interface QuickPhrase { id: string; name: string; content: string }
export interface ConversationListItem {
  id: string
  title: string
  memorySpaceId: string
  createdAt?: number
  pinned?: boolean
  archived?: boolean
}
export interface ConversationSearchResult extends ConversationListItem {
  snippet?: string
  messageId?: string
}

export const DEFAULT_QUICK_PHRASES: QuickPhrase[] = [
  { id: 'table', name: '整理成表格', content: '请将上述信息整理成表格，突出关键差异。' },
  { id: 'actions', name: '提炼行动项', content: '请提炼可执行的行动项，并列出优先级和需要补充的信息。' },
  { id: 'concise', name: '简洁说明', content: '请用简洁、容易理解的语言说明，并给出一个具体例子。' },
]

export interface EditorSelection { start: number; end: number; direction: 'forward' | 'backward' | 'none'; scrollTop: number }
