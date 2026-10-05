import { describe, expect, it } from 'vitest'
import { createConversationRegistry } from './conversation-registry'
import { deleteStoredConversation } from './conversation-deletion'
import { createChatUiStore } from './chat-ui-store'

function storage() { let value: string | undefined; return { load: () => value, save: (next: string) => { value = next } } }

describe('conversation deletion', () => {
  it('removes the active entry, keeps the other space, and stays deleted after restart', async () => {
    const persistence = storage(), registry = createConversationRegistry({ persistence })
    const other = registry.create('另一个项目'), target = registry.create('要删除的对话')
    const closed: string[] = [], cleared: string[] = [], activated: string[] = []
    const result = await deleteStoredConversation({ id: target.id, registry,
      close: async id => { closed.push(id) }, clearHistory: id => { cleared.push(id) },
      activate: async id => { activated.push(id) }, history: () => [], reportError: () => {} })
    expect(closed).toEqual([target.id]); expect(cleared).toEqual([target.id])
    expect(activated).toEqual([result.activeId])
    expect(result.conversations.some(item => item.id === target.id)).toBe(false)
    expect(registry.get(other.id).memorySpaceId).toBe(other.memorySpaceId)
    const reopened = createConversationRegistry({ persistence, legacySessionIds: [target.id] })
    expect(() => reopened.get(target.id)).toThrow()
    expect(reopened.deleted()).toEqual([expect.objectContaining({ id: target.id, deletedAt: expect.any(Number) })])
    expect(reopened.list().some(item => item.id === target.id)).toBe(false)
  })
  it('replaces the only legacy conversation without reusing its shared root directory', async () => {
    const registry = createConversationRegistry({ persistence: storage() })
    const result = await deleteStoredConversation({ id: 'default', registry, close: async () => {}, clearHistory: () => {}, activate: async () => {}, history: () => [], reportError: () => {} })
    expect(result.conversations).toHaveLength(1)
    expect(result.activeId).not.toBe('default')
    expect(registry.active().legacyRoot).toBeUndefined()
    expect(registry.directory(result.activeId, 'application-data')).not.toBe('application-data')
    expect(() => registry.directory('default', 'application-data')).toThrow()
  })
  it('deletes an inactive conversation without restarting the active runtime', async () => {
    const registry = createConversationRegistry({ persistence: storage() })
    const target = registry.create('待删'), active = registry.create('正在使用')
    let activations = 0
    const result = await deleteStoredConversation({ id: target.id, registry, close: async () => {}, clearHistory: () => {}, activate: async () => { activations++ }, history: () => [], reportError: () => {} })
    expect(result.activeId).toBe(active.id)
    expect(activations).toBe(0)
  })
  it('does not clear chat data when the durable registry write fails', async () => {
    const persistence = storage(); createConversationRegistry({ persistence })
    const registry = createConversationRegistry({ persistence: { load: persistence.load, save: () => { throw new Error('disk full') } } })
    let cleared = false
    await expect(deleteStoredConversation({ id: 'default', registry, close: async () => {}, clearHistory: () => { cleared = true }, activate: async () => {}, history: () => [], reportError: () => {} })).rejects.toThrow('disk full')
    expect(cleared).toBe(false)
    expect(registry.active().id).toBe('default')
  })
  it('keeps a removed space inaccessible even when later cleanup fails', async () => {
    const persistence = storage(), registry = createConversationRegistry({ persistence })
    const result = await deleteStoredConversation({ id: 'default', registry, close: async () => {}, clearHistory: () => { throw new Error('I/O failed') }, activate: async () => {}, history: () => [], reportError: () => {} })
    expect(result.warning).toContain('已删除')
    expect(() => createConversationRegistry({ persistence }).get('default')).toThrow()
  })
  it('cleans only the selected conversation drafts and bookmarks, preserving global preferences', () => {
    const persistence = storage(), books = storage(), ui = createChatUiStore(persistence, books)
    ui.saveDrafts([{ conversationId: 'a', draft: { text: '要删除的草稿' } }, { conversationId: 'b', draft: { text: '保留的草稿' } }])
    ui.saveBookmark({ conversationId: 'a', messageId: 'a1', role: 'assistant', content: 'A 的收藏', savedAt: 1 }, true)
    ui.saveBookmark({ conversationId: 'b', messageId: 'b1', role: 'assistant', content: 'B 的收藏', savedAt: 1 }, true)
    const before = ui.snapshot().preferences
    ui.removeConversation('a')
    const reopened = createChatUiStore(persistence, books)
    expect(reopened.snapshot().drafts).toEqual({ b: { text: '保留的草稿' } })
    expect(reopened.snapshot().bookmarks.map(item => item.conversationId)).toEqual(['b'])
    expect(reopened.snapshot().preferences).toEqual(before)
    const saved = persistence.load(); reopened.removeConversation('a'); expect(persistence.load()).toBe(saved)
  })
})
