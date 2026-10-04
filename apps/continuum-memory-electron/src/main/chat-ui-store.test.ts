import { describe, expect, it } from 'vitest'
import { createChatUiStore } from './chat-ui-store'
import { createConversationRegistry } from './conversation-registry'
import { searchConversations } from './conversation-search'
import { buildConversationExport, exportFilename, validateMessageQuote } from '../shared/chat-content'

function storage() { let payload: string | undefined; return { load: () => payload, save: (value: string) => { payload = value } } }
describe('desktop chat utilities', () => {
  it('restores separate drafts and references after reopening, and does not resurrect a sent draft', () => {
    const persistence = storage(), store = createChatUiStore(persistence)
    store.saveDrafts([{ conversationId: 'a', draft: { text: '未发送的问题', quote: { messageId: 'm', role: 'assistant', content: '引用原文' }, skillId: 'pdf' } },
      { conversationId: 'b', draft: { text: '另一段草稿' } }])
    const reopened = createChatUiStore(persistence)
    expect(reopened.snapshot().drafts.a).toMatchObject({ text: '未发送的问题', skillId: 'pdf', quote: { content: '引用原文' } })
    expect(reopened.snapshot().drafts.b?.text).toBe('另一段草稿')
    reopened.saveDrafts([{ conversationId: 'a', draft: { text: '' } }])
    expect(createChatUiStore(persistence).snapshot().drafts).toEqual({ b: { text: '另一段草稿' } })
  })
  it('preserves prior state when saving fails, and refuses to overwrite unreadable data', () => {
    const persistence = storage(), store = createChatUiStore(persistence)
    store.saveDrafts([{ conversationId: 'a', draft: { text: '已保存' } }])
    const failing = createChatUiStore({ load: persistence.load, save() { throw new Error('disk full') } })
    expect(() => failing.saveDrafts([{ conversationId: 'a', draft: { text: '失败的修改' } }])).toThrow('disk full')
    expect(failing.snapshot().drafts.a?.text).toBe('已保存')
    expect(() => createChatUiStore({ load: () => '{broken', save() { throw new Error('must not write') } })).toThrow()
  })
  it('persists phrase edits and intentional deletion of all phrases', () => {
    const persistence = storage(), store = createChatUiStore(persistence)
    store.savePhrases([{ id: 'custom', name: '我的要求', content: '逐项比较。' }])
    expect(createChatUiStore(persistence).snapshot().phrases[0]?.content).toBe('逐项比较。')
    store.savePhrases([])
    expect(createChatUiStore(persistence).snapshot().phrases).toEqual([])
    expect(() => store.savePhrases([{ id: 'same', name: 'A', content: 'a' }, { id: 'same', name: 'B', content: 'b' }])).toThrow()
  })
  it('pins across restart without changing memory partition or active conversation', () => {
    const persistence = storage(), registry = createConversationRegistry({ persistence })
    const a = registry.create('项目 A'), b = registry.create('项目 B')
    registry.pin(a.id, true)
    const reopened = createConversationRegistry({ persistence })
    expect(reopened.active().id).toBe(b.id)
    expect(reopened.get(a.id)).toMatchObject({ pinned: true, memorySpaceId: a.memorySpaceId })
    expect(() => registry.pin(a.id, 'true' as unknown as boolean)).toThrow()
  })
  it('finds Chinese message content in another conversation, excluding tool output', () => {
    const conversations = [{ id: 'a', title: '日常', memorySpaceId: 'a' }, { id: 'b', title: '工作', memorySpaceId: 'b', pinned: true }]
    const histories = { a: [{ id: 'tool', role: 'tool', content: '核验令牌' }], b: [{ id: 'hit', role: 'user', content: '明天整理纸质交接单。' }] }
    const get = (id: string) => histories[id as keyof typeof histories]
    expect(searchConversations(conversations, get, '交接单')).toEqual([expect.objectContaining({ id: 'b', messageId: 'hit', snippet: expect.stringContaining('交接单') })])
    expect(searchConversations(conversations, get, '核验令牌')).toEqual([])
    expect(searchConversations(conversations, get, '')[0]?.id).toBe('b')
  })
  it('validates a formatted excerpt against its source and rejects fabricated or foreign quotes', () => {
    const messages = [{ id: 'source', role: 'assistant', content: '我**喜欢**这个方案。' }]
    expect(validateMessageQuote({ messageId: 'source', role: 'assistant', content: '我喜欢这个方案。' }, messages)?.content).toBe('我喜欢这个方案。')
    expect(() => validateMessageQuote({ messageId: 'other', role: 'assistant', content: '我喜欢' }, messages)).toThrow()
    expect(() => validateMessageQuote({ messageId: 'source', role: 'assistant', content: '伪造的事实' }, messages)).toThrow()
  })
  it('exports only visible dialogue, preserving code in Markdown and quote attribution in text', () => {
    const messages = [{ id: 'u', role: 'user', content: '解释一下', quote: { messageId: 'a', role: 'assistant' as const, content: '原先的回答' } },
      { id: 'a', role: 'assistant', content: '**说明**\n\n```python\nprint("你好")\n```' }, { id: 'private-tool', role: 'tool', content: 'PRIVATE_TOOL_RESULT' }]
    const md = buildConversationExport('项目 A', messages, 'md', '助手')
    expect(md).toContain('```python\nprint("你好")\n```')
    expect(md).toContain('> 引用回答：')
    expect(md).not.toContain('PRIVATE_TOOL_RESULT')
    const txt = buildConversationExport('项目 A', messages, 'txt', '助手')
    expect(txt).toContain('引用回答：\n原先的回答')
    expect(txt).toContain('说明')
    expect(txt).not.toContain('**说明**')
    expect(exportFilename('CON')).toBe('对话_CON')
    expect(exportFilename('项目:/A?')).toBe('项目__A_')
  })
})
