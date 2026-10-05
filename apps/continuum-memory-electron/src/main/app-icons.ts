import { nativeImage, type BrowserWindow, type NativeImage } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolveAppIconTheme } from '../shared/app-icon-theme'

export function createAppIconService(options: { appRoot: string; moduleDirectory: string; packaged: boolean }) {
  const cache = new Map<string, NativeImage>()
  const built = join(options.moduleDirectory, '../renderer/brand/icons')
  const development = join(options.appRoot, 'src/renderer/public/brand/icons')
  function image(theme?: string | null): NativeImage | undefined {
    const id = resolveAppIconTheme(theme)
    const previous = cache.get(id)
    if (previous) return previous
    const directories = options.packaged ? [built] : [development, built]
    const file = directories.map(directory => join(directory, `${id}.png`)).find(existsSync)
    if (!file) return undefined
    const icon = nativeImage.createFromPath(file)
    if (icon.isEmpty()) return undefined
    cache.set(id, icon)
    return icon
  }
  return {
    image,
    update(window: BrowserWindow | null, theme?: string | null) {
      if (!window || window.isDestroyed()) return
      const icon = image(theme)
      if (icon) window.setIcon(icon)
    },
  }
}
