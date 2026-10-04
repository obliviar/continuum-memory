export interface ChatPreferences {
  reading: { fontSize: number; lineHeight: number; contentWidth: number }
  shortcuts: { newConversation: string; focusInput: string; search: string }
  sendKey: 'enter' | 'ctrl-enter'
}
export const DEFAULT_CHAT_PREFERENCES: ChatPreferences = {
  reading: { fontSize: 0, lineHeight: 1.75, contentWidth: 0 },
  shortcuts: { newConversation: 'Ctrl+N', focusInput: 'Ctrl+L', search: 'Ctrl+K' },
  sendKey: 'enter',
}
export function validateChatPreferences(value: unknown): ChatPreferences {
  if (!value || typeof value !== 'object') throw new Error('设置格式不正确。')
  const p = value as ChatPreferences, r = p.reading, s = p.shortcuts
  if (!r || !s || !Number.isFinite(r.fontSize) || (r.fontSize !== 0 && (r.fontSize < 12 || r.fontSize > 28))
    || !Number.isFinite(r.lineHeight) || r.lineHeight < 1.3 || r.lineHeight > 2.4
    || !Number.isFinite(r.contentWidth) || (r.contentWidth !== 0 && (r.contentWidth < 560 || r.contentWidth > 1800))
    || !['enter', 'ctrl-enter'].includes(p.sendKey)) throw new Error('阅读设置超出可用范围。')
  const keys = [s.newConversation, s.focusInput, s.search]
  if (keys.some(key => typeof key !== 'string' || key.length > 50 || !/^(?:(?:Ctrl|Alt|Shift|Meta)\+)+(?:[A-Z0-9]|F(?:[1-9]|1[0-2]))$/.test(key)
    || !/(Ctrl|Alt|Meta)\+/.test(key)) || new Set(keys).size !== keys.length)
    throw new Error('快捷键需要 Ctrl、Alt 或 Meta 修饰，且三个操作不能使用相同按键。')
  return { reading: { ...r }, shortcuts: { ...s }, sendKey: p.sendKey }
}
export function shortcutFromEvent(event: Pick<KeyboardEvent, 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey' | 'key'>): string | undefined {
  const key = event.key.toUpperCase()
  if ((!event.ctrlKey && !event.altKey && !event.metaKey) || !/^(?:[A-Z0-9]|F(?:[1-9]|1[0-2]))$/.test(key)) return undefined
  return [...(event.ctrlKey ? ['Ctrl'] : []), ...(event.altKey ? ['Alt'] : []), ...(event.shiftKey ? ['Shift'] : []), ...(event.metaKey ? ['Meta'] : []), key].join('+')
}
