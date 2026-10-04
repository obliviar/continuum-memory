import { onMounted, onUnmounted, ref } from 'vue'
import { ipcRenderer } from './conversation-ipc'
import type { ChatDraft } from '../../shared/chat-ui'

const copyDraft = (draft: ChatDraft): ChatDraft => ({ text: draft.text, ...(draft.quote ? { quote: { ...draft.quote } } : {}), ...(draft.skillId ? { skillId: draft.skillId } : {}) })

export function useChatDrafts() {
  const drafts = new Map<string, ChatDraft>()
  const pending = new Map<string, { draft: ChatDraft; revision: number }>()
  const status = ref(''), error = ref('')
  let revision = 0, timer: ReturnType<typeof setTimeout> | undefined, inFlight: Promise<boolean> | undefined
  function fail(value: unknown) { error.value = value instanceof Error ? value.message : String(value); status.value = '草稿保存失败' }
  function queue(id: string, draft: ChatDraft) {
    const copied = copyDraft(draft)
    drafts.set(id, copied)
    pending.set(id, { draft: copied, revision: ++revision })
    status.value = '正在保存…'
    clearTimeout(timer)
    timer = setTimeout(() => { void flush() }, 350)
  }
  async function flush(): Promise<boolean> {
    clearTimeout(timer)
    if (inFlight) { const ok = await inFlight; return ok && pending.size ? flush() : ok }
    if (!pending.size) return true
    const batch = [...pending].slice(0, 100)
    inFlight = (async () => {
      try {
        const result = await ipcRenderer.invoke('chat-ui:drafts-save', batch.map(([conversationId, entry]) => ({ conversationId, draft: entry.draft })))
        if (!result.ok) throw new Error(result.error)
        for (const [id, entry] of batch) if (pending.get(id)?.revision === entry.revision) pending.delete(id)
        error.value = ''
        status.value = pending.size ? '正在保存…' : '草稿已保存'
        return true
      } catch (e) { fail(e); return false }
    })()
    const ok = await inFlight
    inFlight = undefined
    if (ok && pending.size) return flush()
    return ok
  }
  function beforeUnload() {
    clearTimeout(timer)
    if (!pending.size) return
    try {
      const result = ipcRenderer.sendSync('chat-ui:drafts-flush', [...pending].map(([conversationId, entry]) => ({ conversationId, draft: entry.draft })))
      if (!result.ok) throw new Error(result.error)
      pending.clear()
    } catch (e) { fail(e) }
  }
  onMounted(() => window.addEventListener('beforeunload', beforeUnload))
  onUnmounted(() => { beforeUnload(); window.removeEventListener('beforeunload', beforeUnload); clearTimeout(timer) })
  return {
    status, error, queue, flush,
    get: (id: string) => copyDraft(drafts.get(id) ?? { text: '' }),
    async load() {
      const state = await ipcRenderer.invoke('chat-ui:get')
      for (const [id, draft] of Object.entries(state.drafts ?? {})) drafts.set(id, copyDraft(draft as ChatDraft))
      if (state.storageError) fail(new Error(state.storageError))
      return state
    },
  }
}
