import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

export interface DesktopConversation {
  id: string
  memorySpaceId: string
  title: string
  createdAt: number
  legacyRoot?: boolean
  pinned?: boolean
  archived?: boolean
}
export function createConversationRegistry(options: {
  persistence: { load(): string | undefined; save(payload: string): void }
  legacySessionIds?: string[]
  now?: () => number
}) {
  const now = options.now ?? Date.now
  const raw = options.persistence.load()
  let state: { version: number; activeId: string; conversations: DesktopConversation[] }
  if (raw) {
    state = JSON.parse(raw)
    if (state.version !== 1 || !Array.isArray(state.conversations) || !state.conversations.length
      || new Set(state.conversations.map(c => c.id)).size !== state.conversations.length
      || new Set(state.conversations.map(c => c.memorySpaceId)).size !== state.conversations.length
      || !state.conversations.some(c => c.id === state.activeId)
      || state.conversations.filter(c => c.legacyRoot).length > 1
      || state.conversations.some(c => typeof c.id !== 'string' || !c.id || c.id.length > 200
        || typeof c.title !== 'string' || !c.title.trim() || c.title.length > 100
        || !Number.isSafeInteger(c.createdAt) || c.createdAt < 0
        || (c.archived !== undefined && typeof c.archived !== 'boolean')
        || (c.pinned !== undefined && typeof c.pinned !== 'boolean')
        || (c.legacyRoot !== undefined && c.legacyRoot !== true)
        || (c.legacyRoot ? c.id !== 'default' || c.memorySpaceId !== 'legacy-default'
          : !/^[0-9a-f-]{36}$/i.test(c.memorySpaceId)))) throw new Error('Invalid conversation registry')
  } else {
    const ids = [...new Set(['default', ...(options.legacySessionIds ?? [])])]
    state = { version: 1, activeId: 'default', conversations: ids.map(id => ({ id,
      memorySpaceId: id === 'default' ? 'legacy-default' : randomUUID(),
      title: id === 'default' ? '历史默认对话' : `历史对话 ${id.slice(0, 30)}`, createdAt: now(),
      ...(id === 'default' ? { legacyRoot: true } : {}) })) }
    options.persistence.save(JSON.stringify(state))
  }
  const commit = (next: typeof state) => { options.persistence.save(JSON.stringify(next)); state = next }
  const get = (id: string) => {
    const entry = state.conversations.find(c => c.id === id)
    if (!entry) throw new Error('Conversation does not exist')
    return structuredClone(entry)
  }
  return {
    list: () => structuredClone(state.conversations),
    active: () => get(state.activeId), get,
    create(title = '新对话') {
      if (typeof title !== 'string' || !title.trim() || title.length > 100) throw new Error('Invalid conversation title')
      const entry = { id: randomUUID(), memorySpaceId: randomUUID(), title: title.trim(), createdAt: now() }
      commit({ ...state, activeId: entry.id, conversations: [...state.conversations, entry] })
      return structuredClone(entry)
    },
    select(id: string) { const entry = get(id); commit({ ...state, activeId: id }); return entry },
    rename(id: string, title: string) {
      get(id)
      if (typeof title !== 'string' || !title.trim() || title.length > 100) throw new Error('Invalid conversation title')
      commit({ ...state, conversations: state.conversations.map(c => c.id === id ? { ...c, title: title.trim() } : c) })
    },
    pin(id: string, pinned: boolean) {
      get(id)
      if (typeof pinned !== 'boolean') throw new Error('Invalid pinned state')
      commit({ ...state, conversations: state.conversations.map(c => c.id === id ? { ...c, pinned } : c) })
    },
    archive(id: string, archived: boolean) {
      get(id)
      if (typeof archived !== 'boolean') throw new Error('Invalid archived state')
      commit({ ...state, conversations: state.conversations.map(c => c.id === id ? { ...c, archived } : c) })
    },
    directory(id: string, root: string) {
      const entry = get(id)
      return entry.legacyRoot ? root : join(root, 'memory-spaces', entry.memorySpaceId)
    },
  }
}
