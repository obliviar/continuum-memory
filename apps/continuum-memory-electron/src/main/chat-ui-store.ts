import { DEFAULT_QUICK_PHRASES, type ChatDraft, type MessageQuote, type QuickPhrase } from '../shared/chat-ui'

import { DEFAULT_CHAT_PREFERENCES, validateChatPreferences, type ChatPreferences } from '../shared/chat-preferences'
import { bookmarkKey, type MessageBookmark } from '../shared/chat-bookmarks'

interface ChatUiState { version: 1; drafts: Record<string, ChatDraft>; phrases: QuickPhrase[]; preferences: ChatPreferences; bookmarks: MessageBookmark[] }
export interface DraftUpdate { conversationId: string; draft: ChatDraft }

function checkedDraft(value: unknown): ChatDraft {
  if (!value || typeof value !== 'object') throw new Error('草稿格式不正确。')
  const draft = value as ChatDraft
  if (typeof draft.text !== 'string' || draft.text.length > 200000 || (draft.skillId !== undefined && (typeof draft.skillId !== 'string' || draft.skillId.length > 200)))
    throw new Error('草稿内容过长或格式不正确。')
  const q = draft.quote
  if (q !== undefined && (!q || typeof q !== 'object' || typeof q.messageId !== 'string' || q.messageId.length > 200
    || !['user', 'assistant'].includes(q.role) || typeof q.content !== 'string' || !q.content.trim() || q.content.length > 12000))
    throw new Error('草稿引用格式不正确。')
  const quote: MessageQuote | undefined = q ? { messageId: q.messageId, role: q.role, content: q.content } : undefined
  return { text: draft.text, ...(quote ? { quote } : {}), ...(draft.skillId ? { skillId: draft.skillId } : {}) }
}
function checkedPhrases(value: unknown): QuickPhrase[] {
  if (!Array.isArray(value) || value.length > 50) throw new Error('最多保存 50 条快捷短语。')
  const ids = new Set<string>()
  return value.map((item: QuickPhrase) => {
    if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 100 || ids.has(item.id)
      || typeof item.name !== 'string' || !item.name.trim() || item.name.trim().length > 40
      || typeof item.content !== 'string' || !item.content.trim() || item.content.length > 4000)
      throw new Error('短语需要唯一标识、名称和内容；名称最多 40 字，内容最多 4000 字。')
    ids.add(item.id)
    return { id: item.id, name: item.name.trim(), content: item.content }
  })
}

export function createChatUiStore(persistence: { load(): string | undefined; save(value: string): void }, bookmarkPersistence?: { load(): string | undefined; save(value: string): void }) {
  let state: ChatUiState = { version: 1, drafts: {}, phrases: structuredClone(DEFAULT_QUICK_PHRASES), preferences: structuredClone(DEFAULT_CHAT_PREFERENCES), bookmarks: [] }
  const raw = persistence.load()
  if (raw) {
    const parsed = JSON.parse(raw) as ChatUiState
    if (parsed.version !== 1 || !parsed.drafts || typeof parsed.drafts !== 'object' || Array.isArray(parsed.drafts)) throw new Error('草稿存储格式不正确。')
    state = { version: 1, drafts: Object.fromEntries(Object.entries(parsed.drafts).map(([id, draft]) => [id, checkedDraft(draft)])), phrases: checkedPhrases(parsed.phrases), preferences: parsed.preferences ? validateChatPreferences(parsed.preferences) : structuredClone(DEFAULT_CHAT_PREFERENCES), bookmarks: checkedBookmarks(parsed.bookmarks ?? []) }
  }
  if (bookmarkPersistence) {
    const saved = bookmarkPersistence.load()
    if (saved) {
      const parsed = JSON.parse(saved)
      if (parsed.version !== 1) throw new Error('收藏存储格式不正确。')
      state.bookmarks = checkedBookmarks(parsed.items)
    } else if (state.bookmarks.length) {
      // Migrate older combined storage only after the bookmark copy is durable.
      bookmarkPersistence.save(JSON.stringify({ version: 1, items: state.bookmarks }))
      persistence.save(JSON.stringify({ ...state, bookmarks: [] }))
    }
  }
  const commit = (next: ChatUiState) => { persistence.save(JSON.stringify(bookmarkPersistence ? { ...next, bookmarks: [] } : next)); state = next }
  return {
    snapshot: () => structuredClone(state),
    uiState: () => structuredClone({ version: state.version, drafts: state.drafts, phrases: state.phrases, preferences: state.preferences }),
    saveDrafts(updates: DraftUpdate[]) {
      if (!Array.isArray(updates) || updates.length > 100) throw new Error('草稿批次格式不正确。')
      const drafts = { ...state.drafts }
      for (const update of updates) {
        if (!update || typeof update.conversationId !== 'string' || !update.conversationId || update.conversationId.length > 200) throw new Error('对话标识不正确。')
        const draft = checkedDraft(update.draft)
        if (!draft.text && !draft.quote && !draft.skillId) delete drafts[update.conversationId]
        else drafts[update.conversationId] = draft
      }
      commit({ ...state, drafts })
    },
    savePreferences(value: unknown) { commit({ ...state, preferences: validateChatPreferences(value) }); return structuredClone(state.preferences) },
    saveBookmark(item: MessageBookmark, saved: boolean) {
      const key = bookmarkKey(item.conversationId, item.messageId)
      const bookmarks = state.bookmarks.filter(row => bookmarkKey(row.conversationId, row.messageId) !== key)
      if (saved) bookmarks.unshift(item)
      const checked = checkedBookmarks(bookmarks)
      if (bookmarkPersistence) { bookmarkPersistence.save(JSON.stringify({ version: 1, items: checked })); state = { ...state, bookmarks: checked } }
      else commit({ ...state, bookmarks: checked })
    },
    savePhrases(phrases: unknown) { commit({ ...state, phrases: checkedPhrases(phrases) }); return structuredClone(state.phrases) },
  }
}

function checkedBookmarks(value: unknown): MessageBookmark[] {
  if (!Array.isArray(value) || value.length > 2000) throw new Error('最多收藏 2000 条消息。')
  const keys = new Set<string>()
  return value.map((item: MessageBookmark) => {
    if (!item || typeof item.conversationId !== 'string' || !item.conversationId || item.conversationId.length > 200
      || typeof item.messageId !== 'string' || !item.messageId || item.messageId.length > 200
      || !['user','assistant'].includes(item.role) || !Number.isSafeInteger(item.savedAt) || item.savedAt < 0)
      throw new Error('收藏消息格式不正确。')
    const draft = checkedDraft({ text: item.content, quote: item.quote })
    const key = bookmarkKey(item.conversationId, item.messageId)
    if (keys.has(key)) throw new Error('收藏消息标识重复。')
    keys.add(key)
    return { conversationId: item.conversationId, messageId: item.messageId, role: item.role, content: draft.text, savedAt: item.savedAt, ...(draft.quote ? { quote: draft.quote } : {}) }
  })
}
