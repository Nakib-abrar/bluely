import type { BrowserWindow, WebContents } from 'electron'

export type WindowKind = 'main' | 'overlay'

/** Tracks Bluely's two windows so services can reach them without import cycles. */
export class WindowRegistry {
  private windows: Partial<Record<WindowKind, BrowserWindow>> = {}

  set(kind: WindowKind, win: BrowserWindow): void {
    this.windows[kind] = win
    win.on('closed', () => {
      if (this.windows[kind] === win) delete this.windows[kind]
    })
  }

  get(kind: WindowKind): BrowserWindow | null {
    const win = this.windows[kind]
    return win && !win.isDestroyed() ? win : null
  }

  all(): BrowserWindow[] {
    return (Object.values(this.windows) as BrowserWindow[]).filter((w) => !w.isDestroyed())
  }

  kindOf(contents: WebContents): WindowKind | null {
    for (const [kind, win] of Object.entries(this.windows) as [WindowKind, BrowserWindow][]) {
      if (!win.isDestroyed() && win.webContents.id === contents.id) return kind
    }
    return null
  }
}
