import { describe, expect, it } from 'vitest'
import { createChatUiStore } from './chat-ui-store'
import { createConversationRegistry } from './conversation-registry'
import { DEFAULT_CHAT_PREFERENCES, shortcutFromEvent } from '../shared/chat-preferences'
import { buildMemoryActivity } from './memory-activity'
import { memoryActivityLabel } from '../shared/memory-activity'
import type { CaptureSnapshot, GraphPublicationTask, SemanticWorkItem } from '@continuum-memory/memory'

function storage() { let payload: string | undefined; return { load: () => payload, save: (value: string) => { payload = value } } }
describe('desktop reading and navigation preferences', () => {
  it('loads old draft storage without discarding drafts, then restores new settings after restart', () => {
    const p = storage()
    p.save(JSON.stringify({ version: 1, drafts: { default: { text: '旧草稿' } }, phrases: [] }))
    const store = createChatUiStore(p)
    expect(store.snapshot().preferences).toEqual(DEFAULT_CHAT_PREFERENCES)
    store.savePreferences({ reading: { fontSize: 19, lineHeight: 2, contentWidth: 820 }, shortcuts: { newConversation: 'Alt+N', focusInput: 'Ctrl+L', search: 'Ctrl+K' }, sendKey: 'ctrl-enter' })
    const reopened = createChatUiStore(p)
    expect(reopened.snapshot().drafts.default?.text).toBe('旧草稿')
    expect(reopened.snapshot().preferences.reading).toEqual({ fontSize: 19, lineHeight: 2, contentWidth: 820 })
    expect(reopened.snapshot().preferences.sendKey).toBe('ctrl-enter')
  })
  it('rejects duplicate shortcuts and invalid display values without changing saved settings', () => {
    const store = createChatUiStore(storage())
    const p = structuredClone(DEFAULT_CHAT_PREFERENCES)
    p.shortcuts.focusInput = p.shortcuts.search
    expect(() => store.savePreferences(p)).toThrow('相同按键')
    p.shortcuts.focusInput = 'Ctrl+L'; p.reading.fontSize = 200
    expect(() => store.savePreferences(p)).toThrow('超出')
    expect(store.snapshot().preferences).toEqual(DEFAULT_CHAT_PREFERENCES)
    expect(shortcutFromEvent({ key: 'n', ctrlKey: true, altKey: false, shiftKey: true, metaKey: false })).toBe('Ctrl+Shift+N')
    expect(shortcutFromEvent({ key: 'Enter', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false })).toBeUndefined()
  })
  it('archives and restores without changing active selection, pinning, or memory-space mapping', () => {
    const p = storage(), registry = createConversationRegistry({ persistence: p })
    const conversation = registry.create('项目记录')
    registry.pin(conversation.id, true)
    const directory = registry.directory(conversation.id, 'root')
    registry.archive(conversation.id, true)
    const reopened = createConversationRegistry({ persistence: p })
    expect(reopened.active().id).toBe(conversation.id)
    expect(reopened.get(conversation.id)).toMatchObject({ archived: true, pinned: true, memorySpaceId: conversation.memorySpaceId })
    expect(reopened.directory(conversation.id, 'root')).toBe(directory)
    reopened.archive(conversation.id, false)
    expect(reopened.get(conversation.id).archived).toBe(false)
  })
  it('does not rewrite bookmark bodies when autosaving a draft, and migrates combined storage', () => {
    const root = storage(), books = storage()
    const item = { conversationId: 'a', messageId: 'm', role: 'assistant' as const, content: '收藏全文'.repeat(100), savedAt: 1 }
    const legacy = createChatUiStore(root)
    legacy.saveBookmark(item, true)
    const split = createChatUiStore(root, books)
    const before = books.load()
    split.saveDrafts([{ conversationId: 'a', draft: { text: '正在输入' } }])
    expect(books.load()).toBe(before)
    expect(root.load()).not.toContain(item.content)
    expect(createChatUiStore(root, books).snapshot().bookmarks).toEqual([item])
    expect(createChatUiStore(root, books).snapshot().drafts.a?.text).toBe('正在输入')
  })
  it('keeps bookmark full text across restart and allows removal even after source history eviction', () => {
    const p = storage(), store = createChatUiStore(p)
    const item = { conversationId: 'a', messageId: 'm', role: 'assistant' as const, content: '# 长期回看的原文\n\n第一段\n第二段', savedAt: 1 }
    store.saveBookmark(item, true)
    store.saveBookmark(item, true)
    const reopened = createChatUiStore(p)
    expect(reopened.snapshot().bookmarks).toEqual([item])
    reopened.saveBookmark(item, false)
    expect(createChatUiStore(p).snapshot().bookmarks).toEqual([])
  })
})
describe('observable memory processing state', () => {
  const scope = { ownerId: 'owner', agentId: 'agent' }
  const capture = (status: string) => ({ version: 1, sources: [{ id: 's', messageIds: ['m'], scope, status: 'active', createdAt: 1, turn: { userMessage: '待核实的原文' } }], tasks: [{ id: 'task', sourceId: 's', status, writtenCount: 0 }] }) as unknown as CaptureSnapshot
  it('does not label successful extraction or semantic review as published L1 facts', () => {
    const semantics = [{ run: { sourceId: 'm' }, status: 'published', decisions: [] }] as unknown as SemanticWorkItem[]
    const report = buildMemoryActivity({ enabled: true, scope, capture: capture('succeeded'), semantics })
    expect(report.totals.published).toBe(0)
    expect(memoryActivityLabel(report.items[0]!)).toBe('已整理')
  })
  it('counts only backed, active publications and retains clarification state', () => {
    const publication = [{ run: { sourceId: 'm' }, state: 'published', factRef: { id: 'fact' } }, { run: { sourceId: 'm' }, state: 'queued', factRef: { id: 'not-published' } }] as unknown as GraphPublicationTask[]
    const semantics = [{ run: { sourceId: 'm' }, status: 'waiting', decisions: [{ verdict: 'needs-context' }] }] as unknown as SemanticWorkItem[]
    const report = buildMemoryActivity({ enabled: true, scope, capture: capture('succeeded'), publication, semantics, activeFactIds: new Set(['fact']) })
    expect(report.totals).toMatchObject({ published: 1, pending: 1, clarifying: 1 })
    expect(buildMemoryActivity({ enabled: true, scope, capture: capture('succeeded'), publication, activeFactIds: new Set() }).totals.published).toBe(0)
  })
  it('reflects running and failed tasks and excludes sources from other scopes', () => {
    expect(memoryActivityLabel(buildMemoryActivity({ enabled: true, scope, capture: capture('running') }).items[0]!)).toBe('处理中')
    expect(memoryActivityLabel(buildMemoryActivity({ enabled: true, scope, capture: capture('failed') }).items[0]!)).toBe('处理失败')
    expect(buildMemoryActivity({ enabled: true, scope: { ownerId: 'other', agentId: 'agent' }, capture: capture('running') }).items).toEqual([])
  })
})
