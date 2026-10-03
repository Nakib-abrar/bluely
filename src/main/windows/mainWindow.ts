import { BrowserWindow, nativeTheme, screen } from 'electron'
import { join } from 'node:path'
import type { Env } from '../env'
import type { Logger } from '../log'
import type { EventBus } from '../ipc/events'
import { guardWebContents, rendererUrl } from './security'
import type { WindowRegistry } from './registry'

export interface MainWindowDeps {
  env: Env
  log: Logger
  windows: WindowRegistry
  events: EventBus
  isTrusted: (url: string) => boolean
  /** Decides what the close button does (minimize while a call or its notes run, otherwise quit). */
  onCloseRequested: (win: BrowserWindow) => 'close' | 'minimize'
  startHidden: boolean
}

export function createMainWindow(deps: MainWindowDeps): BrowserWindow {
  const { workAreaSize } = screen.getPrimaryDisplay()
  const width = Math.min(1120, Math.max(860, Math.round(workAreaSize.width * 0.62)))
  const height = Math.min(780, Math.max(600, Math.round(workAreaSize.height * 0.78)))

  const win = new BrowserWindow({
    width,
    height,
    minWidth: 780,
    minHeight: 540,
    show: false,
    frame: false,
    // Bluely is a visible assistant: the main window always has a taskbar entry.
    skipTaskbar: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0B0B0D' : '#F7F7F8',
    title: 'Bluely',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: true,
      devTools: deps.env.isDev,
    },
  })

  deps.windows.set('main', win)
  guardWebContents(win.webContents, deps.isTrusted, deps.log)

  win.once('ready-to-show', () => {
    if (deps.startHidden) win.minimize()
    else win.show()
  })

  win.on('close', (event) => {
    if (deps.onCloseRequested(win) === 'minimize') {
      event.preventDefault()
      win.minimize()
    }
  })

  const sendMax = () => deps.events.sendTo('main', 'window:maximized', win.isMaximized())
  win.on('maximize', sendMax)
  win.on('unmaximize', sendMax)

  void win.loadURL(rendererUrl(deps.env, 'main'))
  return win
}
