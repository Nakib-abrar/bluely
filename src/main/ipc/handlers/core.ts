import { app, clipboard, shell } from 'electron'
import type { CoreContext } from '../../context'
import { openExternalSafe } from '../../windows/security'
import { isPortableBuild, setLaunchAtStartup } from '../../platform'
import { handle } from '../registry'

/** App, window, clipboard, settings, key and overlay-window handlers. */
export function registerCoreHandlers(ctx: CoreContext, opts: { quit: () => void }): void {
  const { settings, secrets, events, overlay, log } = ctx

  handle('app:getInfo', () => ({
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    platform: process.platform,
    arch: process.arch,
    isPackaged: app.isPackaged,
    isPortable: isPortableBuild(),
    dataDir: ctx.paths.userData,
    devMode: ctx.env.isDev,
  }))
  handle('app:openExternal', ({ url }) => openExternalSafe(url, log))
  handle('app:openMainWindow', ({ route }) => ctx.showMainWindow(route))
  handle('app:openSettings', ({ page }) => {
    ctx.showMainWindow()
    events.sendTo('main', 'settings:open', { page: page ?? null })
  })
  handle('app:openDataFolder', async () => {
    await shell.openPath(ctx.paths.userData)
  })
  handle('app:quit', () => opts.quit())
  handle('app:rendererLog', ({ level, message }, hctx) => {
    log.child(`renderer:${hctx.windowKind ?? '?'}`)[level](message)
  })
  handle('clipboard:writeText', ({ text }) => clipboard.writeText(text))

  handle('window:minimize', (_req, hctx) => hctx.window?.minimize())
  handle('window:toggleMaximize', (_req, hctx) => {
    const win = hctx.window
    if (!win) return false
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return win.isMaximized()
  })
  handle('window:close', (_req, hctx) => hctx.window?.close())
  handle('window:isMaximized', (_req, hctx) => !!hctx.window?.isMaximized())

  handle('settings:get', () => settings.get())
  handle('settings:update', ({ patch }) => settings.update(patch))
  handle('settings:reset', ({ section }) => settings.reset(section))

  handle('key:getStatus', () => secrets.status())
  handle('key:set', ({ key }) => {
    secrets.setKey(key)
    return secrets.status()
  })
  handle('key:clear', () => {
    secrets.clear()
    return secrets.status()
  })

  handle('overlay:toggle', () => overlay.toggle())
  handle('overlay:setVisible', ({ visible }) => (visible ? overlay.show() : overlay.hide()))
  handle('overlay:setExpanded', ({ expanded }) => overlay.setExpanded(expanded))
  handle('overlay:setContentSize', ({ width, height }) => overlay.setContentSize(width, height))
  handle('overlay:setIgnoreMouse', ({ ignore }) => overlay.setIgnoreMouse(ignore))
  handle('overlay:focus', () => overlay.focus())

  // Side effects of settings changes.
  settings.onChange((next, prev) => {
    events.broadcast('settings:changed', next)
    if (next.general.launchAtStartup !== prev.general.launchAtStartup) {
      try {
        setLaunchAtStartup(next.general.launchAtStartup)
      } catch (err) {
        log.warn('Could not update launch at startup', err)
      }
    }
    log.setDebug(next.advanced.devLogging)
  })
}
