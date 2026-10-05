import type { ComputedRef, InjectionKey } from 'vue'
import { resolveAppIconTheme } from '../../shared/app-icon-theme'

export const APP_ICON_THEME: InjectionKey<ComputedRef<string>> = Symbol('continuum-app-icon-theme')
export function appIconUrl(theme?: string | null): string {
  return new URL(`./brand/icons/${resolveAppIconTheme(theme)}.png`, window.location.href).href
}
