import type { MessageQuote } from './chat-ui'

export interface MessageBookmark {
  conversationId: string
  messageId: string
  role: 'user' | 'assistant'
  content: string
  quote?: MessageQuote
  savedAt: number
}
export interface MessageBookmarkView extends MessageBookmark {
  conversationTitle: string
  sourceAvailable: boolean
  archived?: boolean
}
export const bookmarkKey = (conversationId: string, messageId: string) => JSON.stringify([conversationId, messageId])
