import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CoreContext } from '@main/context'
import { openDatabase } from '@main/db/database'
import { EventBus } from '@main/ipc/events'
import { _resetRegistryForTests, initIpcRegistry } from '@main/ipc/registry'
import { SettingsStore } from '@main/settings/settingsStore'
import { wireShortcuts } from '@main/shortcuts'
import { WindowRegistry } from '@main/windows/registry'
import type { IpcEnvelope } from '@shared/ipc'
import type { KeybindStatus } from '@shared/types'
import { type FakeGlobalShortcut, fakeLogger } from './fakes'

type IpcHandler = (event: unknown, raw: unknown) => Promise<unknown>

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>(),
  app: null as EventEmitter | null,
  gs: null as FakeGlobalShortcut | null,
}))

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events')
  const { FakeGlobalShortcut: Fake } = await import('./fakes')
  electron.app = new Emitter()
  electron.gs = new Fake()
  return {
    app: electron.app,
    globalShortcut: electron.gs,
    ipcMain: {
      handle: (channel: string, fn: IpcHandler) => electron.handlers.set(channel, fn),
      removeHandler: (channel: string) => electron.handlers.delete(channel),
    },
  }
})

class FakeOverlayWindow extends EventEmitter {
  visible = false
  focused = false
  isVisible() {
    return this.visible
  }
  isFocused() {
    return this.focused
  }
}

function setup() {
  const log = fakeLogger()
  const windows = new WindowRegistry()
  initIpcRegistry({ windows, log, isTrustedUrl: () => true })
  const events = new EventBus(windows)
  const settings = new SettingsStore(openDatabase(':memory:'))
  const overlay = {
    window: null as FakeOverlayWindow | null,
    isVisible() {
      return !!this.window?.visible
    },
  }
  const ctx = { log, events, settings, overlay, windows } as unknown as CoreContext
  const actions = {
    toggleOverlay: vi.fn(),
    askAssist: vi.fn(),
    stopSession: vi.fn(),
    moveOverlay: vi.fn(),
    runAction: vi.fn(),
  }
  const statuses: KeybindStatus[][] = []
  events.subscribe('keybinds:status', (s) => statuses.push(s))
  const manager = wireShortcuts(ctx, actions)
  const app = electron.app as EventEmitter
  const gs = electron.gs as FakeGlobalShortcut
  return { ctx, events, overlay, settings, actions, manager, app, gs, statuses }
}

const showOverlay = (s: ReturnType<typeof setup>, focused = false) => {
  const win = s.overlay.window ?? new FakeOverlayWindow()
  win.visible = true
  win.focused = focused
  s.overlay.window = win
  s.events.broadcast('overlay:visibility', { visible: true, expanded: true })
  return win
}

describe('wireShortcuts', () => {
  afterEach(() => {
    _resetRegistryForTests()
    electron.app?.removeAllListeners()
    for (const acc of electron.gs?.registered() ?? []) electron.gs?.unregister(acc)
  })

  it('serves keybinds:getStatus through the IPC registry', async () => {
    const s = setup()
    const handler = electron.handlers.get('keybinds:getStatus')
    expect(handler).toBeDefined()
    const sender = { id: 1 }
    const res = (await handler?.(
      { sender, senderFrame: { url: 'bluely://app/main' } },
      undefined,
    )) as IpcEnvelope<KeybindStatus[]>
    expect(res).toEqual({ ok: true, data: s.manager.status() })
  })

  it('follows overlay visibility and focus', () => {
    const s = setup()
    expect(s.gs.registered()).not.toContain('CommandOrControl+Left')

    const win = showOverlay(s)
    expect(s.gs.registered()).toContain('CommandOrControl+Left')
    expect(s.gs.registered()).toContain('CommandOrControl+Shift+Up')

    win.focused = true
    s.app.emit('browser-window-focus', {}, win)
    expect(s.gs.registered()).not.toContain('CommandOrControl+Shift+Up')

    // Focus on another window is ignored.
    s.app.emit('browser-window-blur', {}, new FakeOverlayWindow())
    expect(s.gs.registered()).not.toContain('CommandOrControl+Shift+Up')

    win.focused = false
    s.app.emit('browser-window-blur', {}, win)
    expect(s.gs.registered()).toContain('CommandOrControl+Shift+Up')

    win.visible = false
    s.events.broadcast('overlay:visibility', { visible: false, expanded: true })
    expect(s.gs.registered()).not.toContain('CommandOrControl+Left')
  })

  it('picks up an overlay shown via focus without a visibility event', () => {
    const s = setup()
    const win = new FakeOverlayWindow()
    win.visible = true
    win.focused = true
    s.overlay.window = win
    s.app.emit('browser-window-focus', {}, win)
    expect(s.gs.registered()).toContain('CommandOrControl+Left')
    expect(s.gs.registered()).not.toContain('CommandOrControl+Shift+Up')
  })

  it('reads the initial overlay state and broadcasts status', () => {
    const s = setup()
    expect(s.statuses.length).toBeGreaterThanOrEqual(1)
    const latest = s.statuses[s.statuses.length - 1]
    expect(latest?.find((x) => x.id === 'toggleOverlay')).toMatchObject({ registered: true })
    s.settings.update({ keybinds: { toggleOverlay: 'Alt+B' } })
    expect(s.statuses[s.statuses.length - 1]?.find((x) => x.id === 'toggleOverlay')).toMatchObject({
      accelerator: 'Alt+B',
      registered: true,
    })
    s.gs.press('Alt+B')
    expect(s.actions.toggleOverlay).toHaveBeenCalledTimes(1)
  })

  it('disposes on will-quit and detaches its listeners', () => {
    const s = setup()
    showOverlay(s)
    expect(s.gs.registered().length).toBeGreaterThan(0)
    s.app.emit('will-quit')
    expect(s.gs.registered()).toEqual([])
    expect(s.app.listenerCount('browser-window-focus')).toBe(0)
    expect(s.app.listenerCount('will-quit')).toBe(0)
    // Later visibility events are ignored.
    showOverlay(s)
    expect(s.gs.registered()).toEqual([])
  })
})
