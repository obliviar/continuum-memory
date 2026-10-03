import type { ObjectDirective } from 'vue'

const states = new WeakMap<HTMLElement, { previous: HTMLElement | null; listener: (event: KeyboardEvent) => void }>()
const focusable = (element: HTMLElement) => [...element.querySelectorAll<HTMLElement>(
  'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, [tabindex="0"]',
)].filter(item => item.getClientRects().length > 0)

/** Keep keyboard navigation inside an input dialog and restore the opener on explicit close. */
export const dialogFocus: ObjectDirective<HTMLElement, () => void> = {
  mounted(element, binding) {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const listener = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); binding.value(); return }
      if (event.key !== 'Tab') return
      const items = focusable(element)
      const at = items.indexOf(document.activeElement as HTMLElement)
      if (!items.length) { event.preventDefault(); element.focus(); return }
      if (event.shiftKey && at <= 0) { event.preventDefault(); items.at(-1)!.focus() }
      else if (!event.shiftKey && (at < 0 || at === items.length - 1)) { event.preventDefault(); items[0]!.focus() }
    }
    states.set(element, { previous, listener })
    element.addEventListener('keydown', listener)
    element.tabIndex = -1
    const initial = element.querySelector<HTMLElement>('[data-dialog-autofocus]:not(:disabled)') ?? element
    initial.focus({ preventScroll: true })
  },
  unmounted(element) {
    const state = states.get(element)
    if (!state) return
    element.removeEventListener('keydown', state.listener)
    if (state.previous?.isConnected) state.previous.focus()
    states.delete(element)
  },
}
