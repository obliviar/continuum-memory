import { clipboard, dialog, ipcMain, safeStorage, shell, type BrowserWindow } from 'electron'
import { join, basename } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { createEncryptedFilePersistence } from '@continuum-memory/memory'
import { createChatUiStore, type DraftUpdate } from './chat-ui-store'
import { searchConversations } from './conversation-search'
import type { createConversationRegistry, DesktopConversation } from './conversation-registry'
import { buildConversationExport, exportFilename, type ExportMessage } from '../shared/chat-content'

export function setupChatUiIPC(options: {
  root: string
  registry: ReturnType<typeof createConversationRegistry>
  getMessages(id: string): ExportMessage[]
  window(): BrowserWindow | null
  assistantName(): string
  reportError(message: string): void
  deleteConversation?(id: string): Promise<{ activeId: string; conversations: DesktopConversation[]; history: ExportMessage[]; warning?: string }>
  copyText?(text: string): void
  openLink?(url: string): Promise<void>
  saveExport?(config: Electron.SaveDialogOptions): Promise<{ canceled: boolean; filePath?: string }>
}) {
  let storageError = ''
  let store: ReturnType<typeof createChatUiStore>
  try {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密不可用，草稿和快捷短语暂时无法持久保存。')
    store = createChatUiStore(createEncryptedFilePersistence({
      encryptedPath: join(options.root, 'chat-ui.enc'), keyPath: join(options.root, 'chat-ui-key.json'),
      protectKey: key => safeStorage.encryptString(key.toString('base64')),
      unprotectKey: key => Buffer.from(safeStorage.decryptString(key), 'base64'),
    }), createEncryptedFilePersistence({
      encryptedPath: join(options.root, 'message-bookmarks.enc'), keyPath: join(options.root, 'message-bookmarks-key.json'),
      protectKey: key => safeStorage.encryptString(key.toString('base64')),
      unprotectKey: key => Buffer.from(safeStorage.decryptString(key), 'base64'),
    }))
  } catch (error) {
    storageError = error instanceof Error ? error.message : '草稿存储暂不可用。'
    options.reportError(`chat UI storage unavailable: ${storageError}`)
    // Keep the original file intact if it cannot be read or decrypted.
    store = createChatUiStore({ load: () => undefined, save: () => { throw new Error(storageError) } })
  }
  const failure = (error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : '操作失败，请重试。' })
  const saveDrafts = (updates: DraftUpdate[]) => {
    try {
      if (!Array.isArray(updates) || updates.length > 100) throw new Error('草稿批次格式不正确。')
      for (const update of updates) options.registry.get(update?.conversationId)
      store.saveDrafts(updates)
      return { ok: true as const }
    } catch (error) { return failure(error) }
  }
  const liveIds = () => new Set(options.registry.list().map(item => item.id))
  // Clean remnants of an interrupted deletion; inaccessible registry entries stay hidden if I/O fails.
  for (const entry of options.registry.deleted()) {
    try { store.removeConversation(entry.id) } catch (error) { options.reportError(`Deleted conversation UI cleanup deferred: ${String(error)}`) }
  }
  ipcMain.handle('chat-ui:get', () => {
    const state = store.uiState(), ids = liveIds()
    return { ...state, drafts: Object.fromEntries(Object.entries(state.drafts).filter(([id]) => ids.has(id))), storageError }
  })
  ipcMain.handle('chat-ui:drafts-save', (_event, updates: DraftUpdate[]) => saveDrafts(updates))
  // A final synchronous flush prevents window close from losing a debounced draft.
  ipcMain.on('chat-ui:drafts-flush', (event, updates: DraftUpdate[]) => { event.returnValue = saveDrafts(updates) })
  const bookmarks = () => {
    const ids = liveIds()
    return store.snapshot().bookmarks.filter(item => ids.has(item.conversationId)).map(item => {
    const conversation = options.registry.get(item.conversationId)
    return { ...item, conversationTitle: conversation.title, archived: conversation.archived,
      sourceAvailable: options.getMessages(item.conversationId).some(message => message.id === item.messageId) }
    })
  }
  ipcMain.handle('chat-ui:preferences-save', (_event, value: unknown) => {
    try { return { ok: true, preferences: store.savePreferences(value) } } catch (error) { return failure(error) }
  })
  ipcMain.handle('chat-ui:bookmarks-list', () => {
    try { return { ok: true, items: bookmarks() } } catch (error) { return failure(error) }
  })
  ipcMain.handle('chat-ui:bookmark-set', (_event, id: string, messageId: string, saved: boolean) => {
    try {
      options.registry.get(id)
      if (typeof messageId !== 'string' || typeof saved !== 'boolean') throw new Error('收藏请求格式不正确。')
      const existing = store.snapshot().bookmarks.find(item => item.conversationId === id && item.messageId === messageId)
      const source = options.getMessages(id).find(message => message.id === messageId && ['user','assistant'].includes(message.role))
      if (saved && (!source || !source.content.trim())) throw new Error('原文不在近期记录中，无法添加收藏。')
      const item = source ? { conversationId: id, messageId, role: source.role as 'user' | 'assistant', content: source.content, savedAt: Date.now(), ...(source.quote ? { quote: source.quote } : {}) } : existing
      if (item) store.saveBookmark(item, saved)
      return { ok: true, items: bookmarks() }
    } catch (error) { return failure(error) }
  })
  ipcMain.handle('conversations:delete', async (_event, id: string, input?: { confirmed?: unknown }) => {
    try {
      if (input?.confirmed !== true) throw new Error('请先确认删除对话。')
      options.registry.get(id)
      if (!options.deleteConversation) throw new Error('删除服务暂不可用，请重新启动程序。')
      const result = await options.deleteConversation(id)
      let warning: string | undefined
      try { store.removeConversation(id) } catch (error) { warning = '对话已删除，部分本地缓存将在下次启动时继续清理。'; options.reportError(`Conversation UI cleanup deferred: ${String(error)}`) }
      return { ok: true, ...result, bookmarks: bookmarks(), ...(warning ? { warning } : {}) }
    } catch (error) { return failure(error) }
  })
  ipcMain.handle('conversations:archive', (_event, id: string, archived: boolean) => {
    try { options.registry.archive(id, archived); return { ok: true, conversations: options.registry.list() } } catch (error) { return failure(error) }
  })
  ipcMain.handle('chat-ui:phrases-save', (_event, phrases: unknown) => {
    try { return { ok: true, phrases: store.savePhrases(phrases) } } catch (error) { return failure(error) }
  })
  ipcMain.handle('chat-ui:copy', (_event, text: unknown) => {
    try {
      if (typeof text !== 'string' || text.length > 2000000) throw new Error('复制内容过长或格式不正确。')
      if (options.copyText) options.copyText(text); else clipboard.writeText(text)
      return { ok: true }
    } catch (error) { return failure(error) }
  })
  ipcMain.handle('chat-ui:open-link', async (_event, value: unknown) => {
    try {
      if (typeof value !== 'string' || value.length > 8000) throw new Error('链接格式不正确。')
      const url = new URL(value)
      if (!['https:', 'http:'].includes(url.protocol)) throw new Error('此链接不支持直接打开。')
      if (options.openLink) await options.openLink(url.href); else await shell.openExternal(url.href)
      return { ok: true }
    } catch (error) { return failure(error) }
  })
  ipcMain.handle('conversations:pin', (_event, id: string, pinned: boolean) => {
    try { options.registry.pin(id, pinned); return { ok: true, conversations: options.registry.list() } } catch (error) { return failure(error) }
  })
  ipcMain.handle('conversations:search', (_event, query: unknown) => {
    try { return { ok: true, items: searchConversations(options.registry.list(), options.getMessages, query) } } catch (error) { return failure(error) }
  })
  ipcMain.handle('conversations:export', async (_event, id: string, format: unknown) => {
    try {
      const conversation = options.registry.get(id)
      if (format !== 'md' && format !== 'txt') throw new Error('请选择 Markdown 或 TXT 格式。')
      const snapshot = structuredClone(options.getMessages(id))
      const config = { title: '导出当前对话', defaultPath: `${exportFilename(conversation.title)}.${format}`,
        filters: [{ name: format === 'md' ? 'Markdown' : '纯文本', extensions: [format] }] }
      const window = options.window()
      const result = options.saveExport ? await options.saveExport(config) : window ? await dialog.showSaveDialog(window, config) : await dialog.showSaveDialog(config)
      if (result.canceled || !result.filePath) return { ok: true, canceled: true }
      options.registry.get(id)
      await writeFile(result.filePath, buildConversationExport(conversation.title, snapshot, format, options.assistantName()), 'utf-8')
      return { ok: true, filename: basename(result.filePath) }
    } catch (error) { return failure(error) }
  })
}
