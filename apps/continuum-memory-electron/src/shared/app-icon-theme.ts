export const APP_ICON_THEMES = ['thread-teal', 'thread-copper', 'thread-ink', 'network-ice', 'network-violet', 'network-polar'] as const
export type AppIconTheme = typeof APP_ICON_THEMES[number]

/** Saved legacy palette IDs still resolve to the same artwork as the renderer theme. */
export function resolveAppIconTheme(value?: string | null): AppIconTheme {
  const aliases: Record<string, AppIconTheme> = { dark: 'network-ice', light: 'thread-teal', forest: 'thread-teal', warm: 'thread-copper', ocean: 'network-polar' }
  const id = value ? aliases[value] ?? value : 'thread-teal'
  return APP_ICON_THEMES.includes(id as AppIconTheme) ? id as AppIconTheme : 'thread-teal'
}
