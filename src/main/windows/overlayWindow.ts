import { app, BrowserWindow, screen, type Display, type Rectangle } from 'electron'
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

/** Crash reloads allowed per RELOAD_WINDOW_MS before giving up (a renderer that keeps dying). */
const MAX_RELOADS = 3
const RELOAD_WINDOW_MS = 60_000

/**
 * The always-on-top overlay. It is a normal visible window: no content protection, no
 * capture exclusion. It skips the taskbar only because the main window is always there.
 *
 * Audio capture runs in its renderer, so the window is never closed while Bluely runs: a close
 * request (Alt+F4) hides it, and a crashed renderer is reloaded (it restarts capture for the
 * live session by itself). A renderer that keeps crashing is not reloaded again: its window is
 * destroyed, and the next show (tray, Ctrl+\, a new call) builds a fresh one.
 */
export class OverlayController {
  private win: BrowserWindow | null = null
  private contentHeight: number = OVERLAY.collapsedHeight
  private expanded: boolean
  private saveTimer: NodeJS.Timeout | null = null
  /** Set when Bluely quits (or Windows ends the session): closing is allowed from then on. */
  private closing = false
  private readonly reloads: number[] = []
  private readonly rendererGoneListeners = new Set<(info: RendererGoneInfo) => void>()
  /** The y the user chose, while expanding near the bottom edge pushed the window up. */
  private preferredY: number | null = null
  /** Bounds this controller set last, to tell its own moves from the user's. */
  private appliedBounds: Rectangle | null = null
  /**
   * Set while withHidden() keeps a visible overlay hidden for a screenshot. Show / hide / toggle
   * requests meanwhile change what is restored afterwards instead of the window itself.
   */
  private captureHold: CaptureHold | null = null

  constructor(private readonly deps: OverlayDeps) {
    this.expanded = deps.settings.get().overlay.expanded
    app.on('before-quit', () => {
      this.closing = true
    })
  }

  /**
   * `fn` runs when the overlay renderer crashed or was killed. It is reloaded right after
   * (`restarting`), unless it keeps crashing: then it stays gone until the overlay is shown again.
   */
  onRendererGone(fn: (info: RendererGoneInfo) => void): () => void {
    this.rendererGoneListeners.add(fn)
    return () => this.rendererGoneListeners.delete(fn)
  }

  get window(): BrowserWindow | null {
    return this.win && !this.win.isDestroyed() ? this.win : null
  }

  ensure(): BrowserWindow {
    const existing = this.window
    if (existing) return existing
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const height = this.expanded ? OVERLAY.maxExpandedHeight : OVERLAY.collapsedHeight
    const pos = this.positionFor(display, OVERLAY.windowWidth, height)

    const win = new BrowserWindow({
      x: pos.x,
      y: pos.y,
      width: OVERLAY.windowWidth,
      height,
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
    win.on('moved', () => {
      if (!sameRect(win.getBounds(), this.appliedBounds)) this.preferredY = null
      this.schedulePositionSave()
    })
    // Alt+F4 while typing in the overlay must not end audio capture: hide instead.
    win.on('close', (event) => {
      if (this.closing) return
      event.preventDefault()
      this.hide()
    })
    win.on('session-end', () => {
      this.closing = true
    })
    win.on('closed', () => {
      if (this.win === win) this.win = null
      // Shortcuts and the tray follow visibility.
      this.emitVisibility()
    })
    win.webContents.on('render-process-gone', (_event, details) =>
      this.handleRendererGone(win, details.reason),
    )
    win.webContents.on('unresponsive', () => this.deps.log.warn('Overlay renderer is unresponsive'))
    void win.loadURL(rendererUrl(this.deps.env, 'overlay'))
    this.win = win
    return win
  }

  /** Visible as far as the user is concerned (a screenshot hides it only for a moment). */
  isVisible(): boolean {
    const hold = this.activeHold()
    if (hold) return hold.restore
    return !!this.window?.isVisible()
  }

  show(focus = false): void {
    const hold = this.activeHold()
    if (hold) {
      // Revealed when the screenshot is taken, so it never shows up in it.
      hold.restore = true
      hold.focus ||= focus
      this.emitVisibility()
      return
    }
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
    const hold = this.activeHold()
    if (hold) {
      // Already hidden for a screenshot: stay hidden afterwards.
      hold.restore = false
      hold.focus = false
    } else {
      this.window?.hide()
    }
    this.emitVisibility()
  }

  toggle(): boolean {
    if (this.isVisible()) this.hide()
    else this.show()
    return this.isVisible()
  }

  focus(): void {
    if (this.activeHold()) return this.show(true)
    const win = this.ensure()
    const reveal = () => {
      if (!win.isVisible()) win.show()
      win.focus()
      win.webContents.focus()
      this.emitVisibility()
    }
    if (win.webContents.isLoading()) win.once('ready-to-show', reveal)
    else reveal()
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
    this.preferredY = null
    this.setBounds(win, next)
    this.schedulePositionSave()
  }

  /**
   * Hides the overlay briefly so screenshots never include Bluely itself. A focused overlay
   * (the user is typing a question) gets its focus back: otherwise keystrokes would go to the
   * window behind it, e.g. the meeting app. If the user hides the overlay meanwhile (Ctrl+\),
   * it stays hidden. Overlapping captures share one hold.
   */
  async withHidden<T>(fn: () => Promise<T>, ms: number): Promise<T> {
    const held = this.activeHold()
    if (held) {
      held.depth++
      try {
        return await fn()
      } finally {
        this.releaseHold(held)
      }
    }
    const win = this.window
    if (!win || !win.isVisible()) return fn()
    const hold: CaptureHold = { win, restore: true, focus: win.isFocused(), depth: 1 }
    this.captureHold = hold
    win.hide()
    try {
      await new Promise((r) => setTimeout(r, ms))
      return await fn()
    } finally {
      this.releaseHold(hold)
    }
  }

  /** The capture hold, if the window it hid is still the overlay. */
  private activeHold(): CaptureHold | null {
    const hold = this.captureHold
    if (!hold) return null
    if (hold.win.isDestroyed() || hold.win !== this.win) {
      this.captureHold = null
      return null
    }
    return hold
  }

  private releaseHold(hold: CaptureHold): void {
    if (--hold.depth > 0) return
    if (this.captureHold === hold) this.captureHold = null
    const { win } = hold
    if (!hold.restore || win.isDestroyed() || win !== this.win) return
    if (hold.focus) {
      win.show()
      win.focus()
      win.webContents.focus()
    } else {
      win.showInactive()
    }
  }

  currentDisplay(): Display {
    const win = this.window
    if (!win) return screen.getPrimaryDisplay()
    return screen.getDisplayMatching(win.getBounds())
  }

  destroy(): void {
    this.closing = true
    this.window?.destroy()
    this.win = null
  }

  private handleRendererGone(win: BrowserWindow, reason: string): void {
    if (this.closing || win.isDestroyed()) return
    this.deps.log.error(`Overlay renderer gone (${reason})`)
    const now = Date.now()
    while (this.reloads.length && now - (this.reloads[0] ?? 0) > RELOAD_WINDOW_MS) {
      this.reloads.shift()
    }
    const restarting = this.reloads.length < MAX_RELOADS
    for (const fn of this.rendererGoneListeners) {
      try {
        fn({ restarting })
      } catch (err) {
        this.deps.log.error('Overlay renderer-gone listener failed', err)
      }
    }
    if (restarting) {
      this.reloads.push(now)
      win.webContents.reload()
      return
    }
    // A dead window would come back blank on the next show; build a fresh one then instead.
    // destroy() skips the 'close' guard; 'closed' reports the overlay hidden.
    this.deps.log.error('Overlay renderer keeps crashing; not reloading it again')
    win.destroy()
  }

  /**
   * Resizes to the content height. Growing near the bottom edge moves the window up so the
   * panel stays on screen; shrinking again returns it to where the user put it.
   */
  private applySize(): void {
    const win = this.window
    if (!win) return
    const b = win.getBounds()
    const height = Math.round(this.contentHeight)
    if (b.height === height && b.width === OVERLAY.windowWidth) return
    const wantedY = this.preferredY ?? b.y
    const next = this.clampToDisplay({ x: b.x, y: wantedY, width: OVERLAY.windowWidth, height })
    this.preferredY = next.y !== wantedY ? wantedY : null
    this.setBounds(win, next)
  }

  private setBounds(win: BrowserWindow, bounds: Rectangle): void {
    this.appliedBounds = bounds
    win.setBounds(bounds)
  }

  private positionFor(display: Display, width: number, height: number): { x: number; y: number } {
    const saved = this.deps.settings.get().overlay.positions[String(display.id)]
    const wa = display.workArea
    if (saved) {
      const clamped = this.clampToDisplay({ x: saved.x, y: saved.y, width, height }, display)
      this.preferredY = clamped.y !== saved.y ? saved.y : null
      return { x: clamped.x, y: clamped.y }
    }
    return { x: Math.round(wa.x + (wa.width - width) / 2), y: wa.y + 24 }
  }

  /** Keeps the whole window height inside the work area (and at least 80 px of its width). */
  private clampToDisplay(b: Rectangle, display?: Display): Rectangle {
    const d = display ?? screen.getDisplayMatching(b)
    const wa = d.workArea
    const x = Math.min(Math.max(b.x, wa.x - b.width + 80), wa.x + wa.width - 80)
    const maxY = wa.y + wa.height - Math.min(b.height, wa.height)
    const y = Math.min(Math.max(b.y, wa.y), maxY)
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

export interface RendererGoneInfo {
  /** The renderer is being reloaded (false: it keeps crashing and stays gone for now). */
  restarting: boolean
}

interface CaptureHold {
  win: BrowserWindow
  /** Show the window again afterwards (false once the user hid it meanwhile). */
  restore: boolean
  /** Give it the keyboard focus when showing it again. */
  focus: boolean
  /** withHidden() calls still running. */
  depth: number
}

function sameRect(a: Rectangle, b: Rectangle | null): boolean {
  return !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}
