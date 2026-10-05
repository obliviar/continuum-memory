import type { createConversationRegistry } from './conversation-registry'

/** Registry tombstones revoke access; cleanup errors cannot resurrect a removed conversation. */
export async function deleteStoredConversation<T>(options: {
  id: string
  registry: ReturnType<typeof createConversationRegistry>
  close(id: string): Promise<void>
  clearHistory(id: string): void
  activate(id: string): Promise<void>
  history(id: string): T[]
  reportError(message: string): void
}) {
  options.registry.get(options.id)
  const wasActive = options.registry.active().id === options.id
  await options.close(options.id)
  const next = options.registry.remove(options.id)
  let warning: string | undefined
  try { options.clearHistory(options.id) }
  catch (error) { warning = '对话已删除，历史缓存将在下次启动时继续清理。'; options.reportError(`Deleted history cleanup deferred: ${String(error)}`) }
  if (wasActive) {
    try { await options.activate(next.id) }
    catch (error) { warning = '对话已删除，下一段对话暂未加载完成，请稍后重新选择。'; options.reportError(`Conversation activation deferred: ${String(error)}`) }
  }
  return { activeId: next.id, conversations: options.registry.list(), history: options.history(next.id), ...(warning ? { warning } : {}) }
}
