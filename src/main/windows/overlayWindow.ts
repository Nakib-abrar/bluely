import { BrowserWindow, screen, type Display, type Rectangle } from 'electron'
import { join } from 'node:path'
import { OVERLAY } from '@shared/constants'
import type { Env } from '../env'
import type { Logger } from '../log'
import type { SettingsStore } from '../settings/settingsStore'
import type { EventBus } from '../ipc/events'
import { guardWebContents, rendererUrl } from './security'
import type { WindowRegistry } from './registry'

export interface OverlayDeps {
  env: Env
  log: Logger
  windows: WindowRegistry
  events: EventBus
  settings: SettingsStore
  isTrusted: (url: string) => boolean
}

/**
 * The always-on-top overlay. It is a normal visible window: no content protection, no
 * capture exclusion. It skips the taskbar only because the main window is always there.
 */
export class OverlayController {
  private win: BrowserWindow | null = null
  private contentHeight: number = OVERLAY.collapsedHeight
  private expanded: boolean
  private saveTimer: NodeJS.Timeout | null = null

  constructor(private readonly deps: OverlayDeps) {
    this.expanded = deps.settings.get().overlay.expanded
  }

  get window(): BrowserWindow | null {
    return this.win && !this.win.isDestroyed() ? this.win : null
  }

  ensure(): BrowserWindow {
    const existing = this.window
    if (existing) return existing
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const pos = this.positionFor(display, OVERLAY.windowWidth)

    const win = new BrowserWindow({
      x: pos.x,
      y: pos.y,
      width: OVERLAY.windowWidth,
      height: this.expanded ? OVERLAY.maxExpandedHeight : OVERLAY.collapsedHeight,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      hasShadow: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      title: 'Bluely overlay',
      backgroundColor: '#00000000',
      type: process.platform === 'win32' ? 'toolbar' : undefined,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        // Audio capture and VAD run in this renderer; keep it running while hidden.
        backgroundThrottling: false,
        devTools: this.deps.env.isDev,
      },
    })
    win.setAlwaysOnTop(true, 'screen-saver')
    this.deps.windows.set('overlay', win)
    guardWebContents(win.webContents, this.deps.isTrusted, this.deps.log)
    win.on('moved', () => this.schedulePositionSave())
    win.on('closed', () => {
      this.win = null
    })
    void win.loadURL(rendererUrl(this.deps.env, 'overlay'))
    this.win = win
    return win
  }

  isVisible(): boolean {
    return !!this.window?.isVisible()
  }

  show(focus = false): void {
    const win = this.ensure()
    const reveal = () => {
      if (focus) win.show()
      else win.showInactive()
      this.emitVisibility()
    }
    if (win.webContents.isLoading()) win.once('ready-to-show', reveal)
    else reveal()
  }

  hide(): void {
    this.window?.hide()
    this.emitVisibility()
  }

  toggle(): boolean {
    if (this.isVisible()) this.hide()
    else this.show()
    return this.isVisible()
  }

  focus(): void {
    const win = this.ensure()
    if (!win.isVisible()) win.show()
    win.focus()
    win.webContents.focus()
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded
    this.deps.settings.update({ overlay: { expanded } })
    this.applySize()
    this.emitVisibility()
  }

  isExpanded(): boolean {
    return this.expanded
  }

  /** The renderer reports its content height so the transparent window hugs the UI. */
  setContentSize(_width: number, height: number): void {
    this.contentHeight = Math.min(Math.max(height, 40), OVERLAY.maxExpandedHeight)
    this.applySize()
  }

  setIgnoreMouse(ignore: boolean): void {
    this.window?.setIgnoreMouseEvents(ignore, { forward: true })
  }

  moveBy(dx: number, dy: number): void {
    const win = this.window
    if (!win) return
    const b = win.getBounds()
    const next = this.clampToDisplay({ ...b, x: b.x + dx, y: b.y + dy })
    win.setBounds(next)
    this.schedulePositionSave()
  }

  /** Hides the overlay briefly so screenshots never include Bluely itself. */
  async withHidden<T>(fn: () => Promise<T>, ms: number): Promise<T> {
    const win = this.window
    const wasVisible = !!win?.isVisible()
    if (win && wasVisible) {
      win.hide()
      await new Promise((r) => setTimeout(r, ms))
    }
    try {
      return await fn()
    } finally {
      if (win && wasVisible && !win.isDestroyed()) win.showInactive()
    }
  }

  currentDisplay(): Display {
    const win = this.window
    if (!win) return screen.getPrimaryDisplay()
    return screen.getDisplayMatching(win.getBounds())
  }

  destroy(): void {
    this.window?.destroy()
    this.win = null
  }

  private applySize(): void {
    const win = this.window
    if (!win) return
    const b = win.getBounds()
    const height = Math.round(this.contentHeight)
    if (b.height !== height || b.width !== OVERLAY.windowWidth) {
      win.setBounds(this.clampToDisplay({ x: b.x, y: b.y, width: OVERLAY.windowWidth, height }))
    }
  }

  private positionFor(display: Display, width: number): { x: number; y: number } {
    const saved = this.deps.settings.get().overlay.positions[String(display.id)]
    const wa = display.workArea
    if (saved) {
      const clamped = this.clampToDisplay(
        { x: saved.x, y: saved.y, width, height: OVERLAY.collapsedHeight },
        display,
      )
      return { x: clamped.x, y: clamped.y }
    }
    return { x: Math.round(wa.x + (wa.width - width) / 2), y: wa.y + 24 }
  }

  private clampToDisplay(b: Rectangle, display?: Display): Rectangle {
    const d = display ?? screen.getDisplayMatching(b)
    const wa = d.workArea
    const x = Math.min(Math.max(b.x, wa.x - b.width + 80), wa.x + wa.width - 80)
    const y = Math.min(Math.max(b.y, wa.y), wa.y + wa.height - 40)
    return { ...b, x, y }
  }

  private schedulePositionSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      const win = this.window
      if (!win) return
      const b = win.getBounds()
      const display = screen.getDisplayMatching(b)
      this.deps.settings.update({
        overlay: { positions: { [String(display.id)]: { x: b.x, y: b.y } } },
      })
    }, 400)
  }

  private emitVisibility(): void {
    this.deps.events.broadcast('overlay:visibility', {
      visible: this.isVisible(),
      expanded: this.expanded,
    })
  }
}
