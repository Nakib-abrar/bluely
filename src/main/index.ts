import { app, Menu, type BrowserWindow } from 'electron'
import { applyUserDataOverride, readEnv, resolvePaths } from './env'
import { createLogger } from './log'
import { openDatabase } from './db/database'
import { SettingsStore } from './settings/settingsStore'
import { SecretStore } from './settings/secrets'
import { WindowRegistry } from './windows/registry'
import { EventBus } from './ipc/events'
import { initIpcRegistry } from './ipc/registry'
import { registerCoreHandlers } from './ipc/handlers/core'
import { registerStubHandlers } from './ipc/handlers/stubs'
import {
  hardenSession,
  makeTrustedUrlCheck,
  registerAppScheme,
  rendererDir,
  serveRendererFiles,
} from './windows/security'
import { createMainWindow } from './windows/mainWindow'
import { OverlayController } from './windows/overlayWindow'
import { AppTray } from './tray'
import { applyEarlySwitches, launchedHidden, onReady } from './platform'
import { wireFeatures, type Features } from './features'
import type { CoreContext } from './context'
import type { MainWindowRoute } from '@shared/types'

// ── Before ready ──────────────────────────────────────────────────────────────
applyUserDataOverride()
registerAppScheme()
applyEarlySwitches()

let quitting = false
let features: Features | null = null
let tray: AppTray | null = null

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showMain())
  app
    .whenReady()
    .then(start)
    .catch((err: unknown) => {
      console.error('Bluely failed to start', err)
      app.exit(1)
    })
}

let showMain: (route?: MainWindowRoute) => void = () => undefined

async function start(): Promise<void> {
  onReady()
  Menu.setApplicationMenu(null)

  const env = readEnv()
  const paths = resolvePaths()
  const log = createLogger(paths.logsDir)
  log.info(`Starting Bluely ${app.getVersion()} (Electron ${process.versions.electron})`)

  const db = openDatabase(paths.dbFile)
  const settings = new SettingsStore(db)
  log.setDebug(settings.get().advanced.devLogging)
  const secrets = new SecretStore(
    paths.keyFile,
    env.isPackaged ? null : (process.env['BLUELY_TEST_OPENROUTER_KEY'] ?? null),
  )
  const windows = new WindowRegistry()
  const events = new EventBus(windows)
  const isTrusted = makeTrustedUrlCheck(env)

  if (!env.rendererUrl) serveRendererFiles(rendererDir())
  hardenSession(env, log, isTrusted)
  initIpcRegistry({ windows, log, isTrustedUrl: isTrusted })

  const overlay = new OverlayController({ env, log, windows, events, settings, isTrusted })

  showMain = (route?: MainWindowRoute) => {
    let win = windows.get('main')
    if (!win) {
      win = openMainWindow(false)
    }
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    if (route) {
      const target = win
      const send = () => events.sendTo('main', 'navigate', route)
      if (target.webContents.isLoading()) target.webContents.once('did-finish-load', send)
      else send()
    }
  }

  const ctx: CoreContext = {
    env,
    paths,
    log,
    db,
    settings,
    secrets,
    events,
    windows,
    overlay,
    showMainWindow: (route) => showMain(route),
  }

  registerCoreHandlers(ctx, { quit })
  features = wireFeatures(ctx)
  const stubbed = registerStubHandlers()
  if (stubbed.length) log.debug(`IPC channels without a feature handler: ${stubbed.join(', ')}`)

  const openMainWindow = (startHidden: boolean): BrowserWindow => {
    const win = createMainWindow({
      env,
      log,
      windows,
      events,
      isTrusted,
      startHidden,
      onCloseRequested: () => (!quitting && features?.isLive() ? 'minimize' : 'close'),
    })
    win.on('closed', () => {
      // Closing the main window quits Bluely (the overlay never outlives it).
      if (!quitting) quit()
    })
    if (env.isDev) {
      win.webContents.on('before-input-event', (_e, input) => {
        if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools()
      })
    }
    return win
  }

  openMainWindow(launchedHidden())

  tray = new AppTray({
    openMain: () => showMain(),
    toggleSession: () => features?.toggleSession(),
    toggleOverlay: () => {
      overlay.toggle()
      tray?.refresh()
    },
    openSettings: () => {
      showMain()
      events.sendTo('main', 'settings:open', { page: null })
    },
    quit,
    isLive: () => !!features?.isLive(),
    isOverlayVisible: () => overlay.isVisible(),
  })
  events.subscribe('session:state', () => tray?.refresh())
  events.subscribe('overlay:visibility', () => tray?.refresh())

  app.on('window-all-closed', () => {
    if (!quitting) quit()
  })
}

let shutdownStarted = false
let shutdownDone = false

function quit(): void {
  quitting = true
  app.quit()
}

// Every quit path (tray, Settings › Quit, closing the main window, OS logoff) runs the
// feature shutdown once so a live session is finalized before the process exits.
app.on('before-quit', (event) => {
  quitting = true
  if (shutdownDone) return
  event.preventDefault()
  if (shutdownStarted) return
  shutdownStarted = true
  void Promise.race([
    features?.shutdown() ?? Promise.resolve(),
    new Promise((r) => setTimeout(r, 4000)),
  ])
    .catch(() => undefined)
    .finally(() => {
      shutdownDone = true
      tray?.destroy()
      tray = null
      app.quit()
    })
})
