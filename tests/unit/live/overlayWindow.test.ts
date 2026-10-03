import { beforeEach, describe, expect, it, vi } from 'vitest'

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

const fakes = vi.hoisted(() => ({
  windows: [] as unknown[],
  appListeners: new Map<string, (() => void)[]>(),
}))

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class FakeWebContents extends EventEmitter {
    id = Math.random()
    isLoading = () => false
    isDestroyed = () => false
    send = vi.fn()
    focus = vi.fn()
    reload = vi.fn()
  }
  class FakeBrowserWindow extends EventEmitter {
    webContents = new FakeWebContents()
    bounds: Rect
    visible = false
    focused = false
    destroyed = false
    constructor(opts: Rect) {
      super()
      this.bounds = { x: opts.x, y: opts.y, width: opts.width, height: opts.height }
      fakes.windows.push(this)
    }
    setAlwaysOnTop() {}
    setIgnoreMouseEvents() {}
    loadURL = vi.fn(async () => undefined)
    isDestroyed() {
      return this.destroyed
    }
    isVisible() {
      return this.visible
    }
    isFocused() {
      return this.focused
    }
    show = vi.fn(() => {
      this.visible = true
      this.focused = true
    })
    showInactive = vi.fn(() => {
      this.visible = true
    })
    hide = vi.fn(() => {
      this.visible = false
      this.focused = false
    })
    focus = vi.fn(() => {
      this.focused = true
    })
    getBounds() {
      return { ...this.bounds }
    }
    setBounds = vi.fn((b: Rect) => {
      this.bounds = { ...b }
    })
    /** What Alt+F4 / win.close() does: 'close' can be prevented, otherwise 'closed'. */
    close() {
      let prevented = false
      this.emit('close', { preventDefault: () => (prevented = true) })
      if (!prevented) this.destroy()
    }
    destroy() {
      this.destroyed = true
      this.visible = false
      this.emit('closed')
    }
  }
  const display = {
    id: 1,
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    size: { width: 1920, height: 1080 },
    scaleFactor: 1,
  }
  return {
    app: {
      on: (event: string, fn: () => void) => {
        fakes.appListeners.set(event, [...(fakes.appListeners.get(event) ?? []), fn])
      },
    },
    BrowserWindow: FakeBrowserWindow,
    screen: {
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      getDisplayNearestPoint: () => display,
      getDisplayMatching: () => display,
      getPrimaryDisplay: () => display,
    },
  }
})

vi.mock('@main/windows/security', () => ({
  guardWebContents: () => undefined,
  rendererUrl: () => 'bluely://app/overlay.html',
}))

import { OverlayController } from '@main/windows/overlayWindow'
import { WindowRegistry } from '@main/windows/registry'
import { EventBus } from '@main/ipc/events'
import { createLogger } from '@main/log'
import type { SettingsStore } from '@main/settings/settingsStore'
import type { Env } from '@main/env'

interface FakeWin {
  webContents: {
    emit: (e: string, ...a: unknown[]) => void
    reload: ReturnType<typeof vi.fn>
    focus: ReturnType<typeof vi.fn>
  }
  bounds: Rect
  visible: boolean
  focused: boolean
  destroyed: boolean
  show: ReturnType<typeof vi.fn>
  showInactive: ReturnType<typeof vi.fn>
  focus: ReturnType<typeof vi.fn>
  setBounds: ReturnType<typeof vi.fn>
  emit: (e: string, ...a: unknown[]) => void
  close: () => void
}

function setup(opts: { expanded?: boolean; saved?: { x: number; y: number } } = {}) {
  fakes.windows.length = 0
  fakes.appListeners.clear()
  const windows = new WindowRegistry()
  const events = new EventBus(windows)
  const visibility: { visible: boolean; expanded: boolean }[] = []
  events.subscribe('overlay:visibility', (v) => visibility.push(v))
  const settings = {
    get: () => ({
      overlay: {
        expanded: opts.expanded ?? false,
        positions: opts.saved ? { '1': opts.saved } : {},
      },
    }),
    update: vi.fn(),
  } as unknown as SettingsStore
  const overlay = new OverlayController({
    env: { isDev: false } as Env,
    log: createLogger(null),
    windows,
    events,
    settings,
    isTrusted: () => true,
  })
  const win = () => fakes.windows.at(-1) as FakeWin
  const quit = () => fakes.appListeners.get('before-quit')?.forEach((fn) => fn())
  return { overlay, win, visibility, quit }
}

beforeEach(() => {
  vi.useRealTimers()
})

describe('OverlayController: the capture window is never closed mid-call (F6, OV-04, platform F5)', () => {
  it('Alt+F4 hides the overlay instead of closing it, and reports it hidden', () => {
    const h = setup()
    h.overlay.show()
    h.win().close()
    expect(h.win().destroyed).toBe(false)
    expect(h.overlay.window).not.toBeNull()
    expect(h.overlay.isVisible()).toBe(false)
    // Shortcuts (Ctrl+Arrows) and the tray follow this.
    expect(h.visibility.at(-1)).toMatchObject({ visible: false })
  })

  it('closes for real once Bluely quits', () => {
    const h = setup()
    h.overlay.show()
    h.quit()
    h.win().close()
    expect(h.win().destroyed).toBe(true)
    expect(h.overlay.window).toBeNull()
    expect(h.visibility.at(-1)).toMatchObject({ visible: false })
  })

  it('reloads a crashed renderer (which restarts capture) and tells listeners', () => {
    const h = setup()
    h.overlay.show()
    const gone = vi.fn()
    h.overlay.onRendererGone(gone)
    h.win().webContents.emit('render-process-gone', {}, { reason: 'crashed' })
    expect(gone).toHaveBeenCalledTimes(1)
    expect(h.win().webContents.reload).toHaveBeenCalledTimes(1)
  })

  it('stops reloading a renderer that keeps crashing', () => {
    const h = setup()
    h.overlay.show()
    for (let i = 0; i < 5; i++) {
      h.win().webContents.emit('render-process-gone', {}, { reason: 'oom' })
    }
    expect(h.win().webContents.reload).toHaveBeenCalledTimes(3)
  })
})

describe('OverlayController: screen capture keeps the focus (F8)', () => {
  it('gives the focus back to an overlay the user was typing in', async () => {
    const h = setup()
    h.overlay.focus()
    const win = h.win()
    win.show.mockClear()
    win.showInactive.mockClear()
    await h.overlay.withHidden(async () => {
      expect(win.visible).toBe(false)
    }, 0)
    expect(win.visible).toBe(true)
    expect(win.focus).toHaveBeenCalled()
    expect(win.webContents.focus).toHaveBeenCalled()
    expect(win.showInactive).not.toHaveBeenCalled()
  })

  it('restores an unfocused overlay without taking the focus', async () => {
    const h = setup()
    h.overlay.show(false)
    const win = h.win()
    win.show.mockClear()
    await h.overlay.withHidden(async () => undefined, 0)
    expect(win.showInactive).toHaveBeenCalled()
    expect(win.show).not.toHaveBeenCalled()
    expect(win.focused).toBe(false)
  })

  it('stays hidden when the user hides it while the screenshot is taken (Ctrl+\\)', async () => {
    const h = setup()
    h.overlay.focus()
    const win = h.win()
    win.show.mockClear()
    win.showInactive.mockClear()
    await h.overlay.withHidden(async () => {
      // Hidden only for the screenshot: to the user (and the toggle) it is still showing.
      expect(h.overlay.isVisible()).toBe(true)
      expect(h.overlay.toggle()).toBe(false)
    }, 0)
    expect(win.visible).toBe(false)
    expect(win.show).not.toHaveBeenCalled()
    expect(win.showInactive).not.toHaveBeenCalled()
    expect(h.visibility.at(-1)).toMatchObject({ visible: false })
  })

  it('a show or focus request during the screenshot waits until it is taken', async () => {
    const h = setup()
    h.overlay.show(false)
    const win = h.win()
    await h.overlay.withHidden(async () => {
      h.overlay.hide()
      h.overlay.focus()
      // Never in the screenshot.
      expect(win.visible).toBe(false)
      expect(h.overlay.isVisible()).toBe(true)
    }, 0)
    expect(win.visible).toBe(true)
    expect(win.webContents.focus).toHaveBeenCalled()
  })

  it('overlapping screenshots show the overlay again only after the last one', async () => {
    const h = setup()
    h.overlay.show(false)
    const win = h.win()
    let releaseFirst!: () => void
    let releaseSecond!: () => void
    const first = h.overlay.withHidden(() => new Promise<void>((r) => (releaseFirst = r)), 0)
    await new Promise((r) => setTimeout(r, 5))
    const second = h.overlay.withHidden(() => new Promise<void>((r) => (releaseSecond = r)), 0)
    await new Promise((r) => setTimeout(r, 5))
    releaseFirst()
    await first
    expect(win.visible).toBe(false)
    releaseSecond()
    await second
    expect(win.visible).toBe(true)
    expect(win.showInactive).toHaveBeenCalledTimes(2) // the initial show(false), then the restore
  })
})

describe('OverlayController: the expanded panel stays on screen (OV-05)', () => {
  it('expanding near the bottom moves the window up; collapsing puts the pill back', () => {
    const h = setup()
    h.overlay.show()
    const win = h.win()
    // The user dragged the pill to the bottom of the work area (1040 px high).
    win.bounds = { x: 400, y: 970, width: 560, height: 64 }
    win.emit('moved')
    h.overlay.setContentSize(560, 600)
    expect(win.bounds).toEqual({ x: 400, y: 440, width: 560, height: 600 })
    h.overlay.setContentSize(560, 64)
    expect(win.bounds).toEqual({ x: 400, y: 970, width: 560, height: 64 })
  })

  it('keyboard moves cannot push the expanded panel off screen', () => {
    const h = setup()
    h.overlay.show()
    const win = h.win()
    h.overlay.setContentSize(560, 600)
    h.overlay.moveBy(0, 5000)
    expect(win.bounds.y + win.bounds.height).toBeLessThanOrEqual(1040)
  })

  it('an expanded overlay created at a saved low position starts fully on screen', () => {
    const h = setup({ expanded: true, saved: { x: 300, y: 1000 } })
    h.overlay.show()
    const b = h.win().bounds
    expect(b.y + b.height).toBeLessThanOrEqual(1040)
  })
})
