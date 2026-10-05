export interface Theme {
  id: string; name: string; bg: string; surface: string; surfaceHover: string; border: string
  text: string; textMuted: string; accent: string; accentHover: string; accentSoft: string; scrollThumb: string
  family?: 'warm' | 'tech'; scheme?: 'light' | 'dark'; sidebar?: string; accentInk?: string
  onAccent?: string; marker?: string; userBubble?: string; logoPrimary?: string; logoSecondary?: string
}

export const themes: Theme[] = [
  { id: 'thread-teal', name: '松石与纸白', logoPrimary: '#173e42', logoSecondary: '#f6a619', family: 'warm', scheme: 'light', bg: '#f7f6f1', surface: '#fffefa', sidebar: '#edf0e9', surfaceHover: '#e6ece4', border: '#dce1d8', text: '#203436', textMuted: '#57686b', accent: '#245c59', accentHover: '#194a48', accentSoft: '#deebe4', scrollThumb: '#b4c5bc', marker: '#ad744e', userBubble: '#e1e8dd' },
  { id: 'thread-copper', name: '铜棕与暖砂', family: 'warm', scheme: 'light', bg: '#faf5ee', surface: '#fffcf6', sidebar: '#f1e8dc', surfaceHover: '#f2e6d8', border: '#e5d8c8', text: '#3e2d24', textMuted: '#725e51', accent: '#88523b', accentHover: '#70412f', accentSoft: '#f0decd', scrollThumb: '#ccb6a0', marker: '#a77b43', userBubble: '#f2dfd0' },
  { id: 'thread-ink', name: '墨蓝与雾灰', family: 'warm', scheme: 'light', bg: '#f4f5f5', surface: '#fffefa', sidebar: '#e9edf0', surfaceHover: '#e3e9ef', border: '#d6dee5', text: '#243649', textMuted: '#57677c', accent: '#244c6d', accentHover: '#193b59', accentSoft: '#dfe9f1', scrollThumb: '#afbdca', marker: '#ad8351', userBubble: '#dfe8f0' },
  { id: 'network-ice', name: '石墨与冰蓝', family: 'tech', scheme: 'dark', bg: '#161e27', surface: '#202a35', sidebar: '#1b2631', surfaceHover: '#2b3a49', border: '#354757', text: '#e7f0f7', textMuted: '#a1b5c6', accent: '#a8d9f7', accentHover: '#c1e8ff', accentInk: '#a8d9f7', onAccent: '#142532', accentSoft: '#2b4355', scrollThumb: '#486174', marker: '#85d8ee', userBubble: '#2e4359' },
  { id: 'network-violet', name: '深空与电紫', family: 'tech', scheme: 'dark', bg: '#131625', surface: '#1d2137', sidebar: '#181c30', surfaceHover: '#2b2f4b', border: '#383d60', text: '#eeedfa', textMuted: '#b0b0cd', accent: '#6750c5', accentHover: '#7560cf', accentInk: '#c6bcff', onAccent: '#ffffff', accentSoft: '#302b50', scrollThumb: '#514b78', marker: '#b3a0ff', userBubble: '#343353' },
  { id: 'network-polar', name: '极地与青光', family: 'tech', scheme: 'light', bg: '#f1f8fc', surface: '#fcfeff', sidebar: '#e6f2f8', surfaceHover: '#dfedf5', border: '#c8dfea', text: '#193b4e', textMuted: '#4c6c7e', accent: '#006c88', accentHover: '#00566e', accentSoft: '#d9f1f8', scrollThumb: '#a2c7d9', marker: '#008eaa', userBubble: '#d9eff7' },
]

/** Keep old saved themes usable without modifying the user's settings file. */
export function resolveTheme(id: string): Theme | undefined {
  const legacy: Record<string, string> = { dark: 'network-ice', light: 'thread-teal', forest: 'thread-teal', warm: 'thread-copper', ocean: 'network-polar' }
  return themes.find(theme => theme.id === (legacy[id] ?? id))
}
