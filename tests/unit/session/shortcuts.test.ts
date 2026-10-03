import { describe, expect, it, vi } from 'vitest'
import { openDatabase } from '@main/db/database'
import { SettingsStore } from '@main/settings/settingsStore'
import { KEYBIND_STATUS_ERRORS, ShortcutManager, type ShortcutActions } from '@main/shortcuts'
import type { EventChannel, EventPayload } from '@shared/ipc'
import type { KeybindStatus } from '@shared/types'
import { FakeGlobalShortcut, fakeLogger } from './fakes'

const CTRL = 'CommandOrControl'
const DEFAULT_GLOBALS = [
  `${CTRL}+\\`,
  `${CTRL}+Enter`,
  `${CTRL}+Shift+\\`,
  `${CTRL}+Shift+1`,
  `${CTRL}+Shift+2`,
  `${CTRL}+Shift+3`,
].sort()
const ARROWS_SMALL = ['Up', 'Down', 'Left', 'Right'].map((a) => `${CTRL}+${a}`)
const ARROWS_LARGE = ['Up', 'Down', 'Left', 'Right'].map((a) => `${CTRL}+Shift+${a}`)

function setup(prepare?: (gs: FakeGlobalShortcut, settings: SettingsStore) => void) {
  const gs = new FakeGlobalShortcut()
  const settings = new SettingsStore(openDatabase(':memory:'))
  prepare?.(gs, settings)
  const broadcasts: KeybindStatus[][] = []
  const events = {
    broadcast: <E extends EventChannel>(event: E, payload: EventPayload<E>) => {
      if (event === 'keybinds:status') broadcasts.push(payload as KeybindStatus[])
    },
  }
  const actions = {
    toggleOverlay: vi.fn(),
    askAssist: vi.fn(),
    stopSession: vi.fn(),
    moveOverlay: vi.fn(),
    runAction: vi.fn(),
  } satisfies ShortcutActions
  const log = fakeLogger()
  const manager = new ShortcutManager({ settings, events, log, actions, globalShortcut: gs })
  const statusOf = (id: string) => manager.status().find((s) => s.id === id)
  return { gs, settings, broadcasts, actions, log, manager, statusOf }
}

describe('ShortcutManager', () => {
  it('registers the default global binds and reports status', () => {
    const { gs, manager, broadcasts, actions } = setup()
    expect(gs.registered()).toEqual(DEFAULT_GLOBALS)
    expect(broadcasts).toHaveLength(1)
    expect(broadcasts[0]).toEqual(manager.status())

    const status = manager.status()
    expect(status.map((s) => s.id)).toEqual([
      'toggleOverlay',
      'askAssist',
      'stopSession',
      'moveOverlay',
      'actionSay',
      'actionFollowups',
      'actionRecap',
      'clearChat',
      'scrollChat',
      'devPanel',
    ])
    for (const s of status) {
      if (s.id === 'moveOverlay') {
        // Inactive while the overlay is hidden: not an error, and says so explicitly.
        expect(s).toEqual({
          id: s.id,
          accelerator: CTRL,
          registered: false,
          error: null,
          reason: 'inactive',
        })
      } else {
        expect(s).toMatchObject({ registered: true, error: null, reason: null })
      }
    }
    expect(status.find((s) => s.id === 'clearChat')?.accelerator).toBe(`${CTRL}+R`)

    gs.press(`${CTRL}+\\`)
    gs.press(`${CTRL}+Enter`)
    gs.press(`${CTRL}+Shift+\\`)
    gs.press(`${CTRL}+Shift+1`)
    gs.press(`${CTRL}+Shift+2`)
    gs.press(`${CTRL}+Shift+3`)
    expect(actions.toggleOverlay).toHaveBeenCalledTimes(1)
    expect(actions.askAssist).toHaveBeenCalledTimes(1)
    expect(actions.stopSession).toHaveBeenCalledTimes(1)
    expect(actions.runAction.mock.calls).toEqual([['say'], ['followups'], ['recap']])
  })

  it('reports binds taken by another app and keeps the rest working', () => {
    const { gs, statusOf, log } = setup((g) => g.taken.add(`${CTRL}+Enter`))
    expect(statusOf('askAssist')).toEqual({
      id: 'askAssist',
      accelerator: `${CTRL}+Enter`,
      registered: false,
      error: KEYBIND_STATUS_ERRORS.taken,
      reason: 'taken',
    })
    expect(KEYBIND_STATUS_ERRORS.taken).toBe('Taken by another app')
    expect(statusOf('toggleOverlay')).toMatchObject({ registered: true, error: null })
    expect(gs.registered()).not.toContain(`${CTRL}+Enter`)
    expect(log.lines.some((l) => l.level === 'warn' && l.message.includes('taken'))).toBe(true)
  })

  it('retries a taken bind later and reports it once free', () => {
    const { gs, manager, statusOf } = setup((g) => g.taken.add(`${CTRL}+Enter`))
    gs.taken.delete(`${CTRL}+Enter`)
    manager.setOverlayVisible(true)
    expect(statusOf('askAssist')).toMatchObject({ registered: true, error: null })
    expect(gs.registered()).toContain(`${CTRL}+Enter`)
  })

  it('reports invalid shortcuts (bad syntax, reserved, rejected by Electron)', () => {
    const { gs, settings, statusOf } = setup((g) => g.unparsable.add(`${CTRL}+Shift+2`))
    expect(statusOf('actionFollowups')).toMatchObject({
      registered: false,
      error: KEYBIND_STATUS_ERRORS.invalid,
      reason: 'invalid',
    })
    expect(KEYBIND_STATUS_ERRORS.invalid).toBe('Invalid shortcut')

    settings.update({
      keybinds: { askAssist: 'Enter', actionRecap: 'Ctrl+C', clearChat: 'Ctrl+Nope' },
    })
    expect(statusOf('askAssist')).toEqual({
      id: 'askAssist',
      accelerator: 'Enter',
      registered: false,
      error: 'Invalid shortcut',
      reason: 'invalid',
    })
    // Never steal copy/paste system-wide.
    expect(statusOf('actionRecap')).toMatchObject({ registered: false, error: 'Invalid shortcut' })
    expect(statusOf('clearChat')).toMatchObject({ registered: false, error: 'Invalid shortcut' })
    expect(gs.registered()).not.toContain(`${CTRL}+Enter`)
    expect(gs.registered()).not.toContain(`${CTRL}+C`)
  })

  it('treats null as disabled', () => {
    const { gs, settings, statusOf } = setup()
    settings.update({ keybinds: { actionRecap: null, devPanel: null } })
    expect(gs.registered()).not.toContain(`${CTRL}+Shift+3`)
    expect(statusOf('actionRecap')).toEqual({
      id: 'actionRecap',
      accelerator: null,
      registered: false,
      error: 'Disabled',
      reason: 'disabled',
    })
    expect(statusOf('devPanel')).toMatchObject({ registered: false, error: 'Disabled' })
  })

  it('refuses Shift-only shortcuts, which would swallow typing or text selection', () => {
    const { gs, settings, manager, statusOf } = setup()
    settings.update({
      keybinds: { actionSay: 'Shift+S', actionFollowups: 'shift+1', moveOverlay: 'Shift' },
    })
    manager.setOverlayVisible(true)
    for (const id of ['actionSay', 'actionFollowups', 'moveOverlay']) {
      expect(statusOf(id)).toMatchObject({
        registered: false,
        error: KEYBIND_STATUS_ERRORS.invalid,
        reason: 'invalid',
      })
    }
    expect(gs.registered().filter((a) => a.startsWith('Shift+'))).toEqual([])
    // Shift with Ctrl/Alt, or on an F-key, is still fine.
    settings.update({ keybinds: { actionSay: 'Alt+Shift+S', actionFollowups: 'Shift+F7' } })
    expect(gs.registered()).toEqual(expect.arrayContaining(['Alt+Shift+S', 'Shift+F7']))
    expect(statusOf('actionFollowups')).toMatchObject({ registered: true, reason: null })
  })

  it('registers move-overlay arrows only while the overlay is visible', () => {
    const { gs, manager, actions, statusOf } = setup()
    expect(gs.registered()).toEqual(DEFAULT_GLOBALS)

    manager.setOverlayVisible(true)
    expect(gs.registered()).toEqual([...DEFAULT_GLOBALS, ...ARROWS_SMALL, ...ARROWS_LARGE].sort())
    expect(statusOf('moveOverlay')).toMatchObject({ registered: true, error: null, reason: null })

    gs.press(`${CTRL}+Left`)
    gs.press(`${CTRL}+Up`)
    gs.press(`${CTRL}+Shift+Right`)
    gs.press(`${CTRL}+Shift+Down`)
    expect(actions.moveOverlay.mock.calls).toEqual([
      [-10, 0],
      [0, -10],
      [50, 0],
      [0, 50],
    ])

    manager.setOverlayVisible(false)
    expect(gs.registered()).toEqual(DEFAULT_GLOBALS)
    expect(statusOf('moveOverlay')).toMatchObject({
      registered: false,
      error: null,
      reason: 'inactive',
    })
  })

  it('uses the small step only when the move base already contains Shift', () => {
    const { gs, settings, manager, actions } = setup()
    settings.update({ keybinds: { moveOverlay: 'Alt+Shift', scrollChat: null } })
    manager.setOverlayVisible(true)
    const moves = gs.registered().filter((a) => a.startsWith('Alt+'))
    expect(moves).toEqual(['Alt+Shift+Down', 'Alt+Shift+Left', 'Alt+Shift+Right', 'Alt+Shift+Up'])
    gs.press('Alt+Shift+Right')
    expect(actions.moveOverlay).toHaveBeenLastCalledWith(10, 0)
  })

  it('suspends globals shadowed by local binds while the overlay is focused', () => {
    const { gs, manager, broadcasts, statusOf } = setup()
    manager.setOverlayVisible(true)
    const before = broadcasts.length

    manager.setOverlayFocused(true)
    // Ctrl+Shift+↑/↓ is the overlay's local scroll; the 50 px vertical moves step aside.
    expect(gs.registered()).not.toContain(`${CTRL}+Shift+Up`)
    expect(gs.registered()).not.toContain(`${CTRL}+Shift+Down`)
    expect(gs.registered()).toContain(`${CTRL}+Shift+Left`)
    expect(gs.registered()).toContain(`${CTRL}+Up`)
    expect(gs.registered()).toContain(`${CTRL}+\\`)
    // Suspension is transparent in the status: no change, no broadcast.
    expect(statusOf('moveOverlay')).toMatchObject({ registered: true, error: null })
    expect(broadcasts.length).toBe(before)

    manager.setOverlayFocused(false)
    expect(gs.registered()).toContain(`${CTRL}+Shift+Up`)
    expect(gs.registered()).toContain(`${CTRL}+Shift+Down`)
  })

  it('suspends a remapped global that collides with a local bind', () => {
    const { gs, settings, manager } = setup()
    settings.update({ keybinds: { actionSay: 'Ctrl+Shift+D' } })
    expect(gs.registered()).toContain(`${CTRL}+Shift+D`)
    manager.setOverlayVisible(true)
    manager.setOverlayFocused(true)
    expect(gs.registered()).not.toContain(`${CTRL}+Shift+D`)
    manager.setOverlayFocused(false)
    expect(gs.registered()).toContain(`${CTRL}+Shift+D`)
    // Hiding the overlay also ends focus.
    manager.setOverlayFocused(true)
    manager.setOverlayVisible(false)
    expect(gs.registered()).toContain(`${CTRL}+Shift+D`)
  })

  it('re-registers on keybind changes as a diff and ignores other settings', () => {
    const { gs, settings, broadcasts, actions, statusOf } = setup()
    const callsBefore = gs.calls.length
    const broadcastsBefore = broadcasts.length

    settings.update({ general: { theme: 'light' } })
    expect(gs.calls.length).toBe(callsBefore)
    expect(broadcasts.length).toBe(broadcastsBefore)

    settings.update({ keybinds: { askAssist: 'Alt+Enter' } })
    expect(gs.calls.slice(callsBefore)).toEqual([`-${CTRL}+Enter`, '+Alt+Enter'])
    expect(gs.registered()).toContain('Alt+Enter')
    expect(statusOf('askAssist')).toMatchObject({ accelerator: 'Alt+Enter', registered: true })
    expect(broadcasts.length).toBe(broadcastsBefore + 1)
    gs.press('Alt+Enter')
    expect(actions.askAssist).toHaveBeenCalledTimes(1)
  })

  it('gives a remapped accelerator the new callback', () => {
    const { gs, settings, actions } = setup()
    settings.update({
      keybinds: { actionSay: `${CTRL}+Shift+3`, actionRecap: `${CTRL}+Shift+1` },
    })
    gs.press(`${CTRL}+Shift+1`)
    gs.press(`${CTRL}+Shift+3`)
    expect(actions.runAction.mock.calls).toEqual([['recap'], ['say']])
  })

  it('flags two global binds on the same keys', () => {
    const { settings, statusOf, gs } = setup()
    settings.update({ keybinds: { actionFollowups: `${CTRL}+Shift+1` } })
    expect(statusOf('actionSay')).toMatchObject({ registered: true, error: null })
    expect(statusOf('actionFollowups')).toMatchObject({
      registered: false,
      error: KEYBIND_STATUS_ERRORS.duplicate,
      reason: 'duplicate',
    })
    expect(gs.registered()).not.toContain(`${CTRL}+Shift+2`)
  })

  it('normalizes accelerator spelling', () => {
    const { gs, settings, statusOf } = setup()
    settings.update({ keybinds: { stopSession: 'shift+ctrl+q' } })
    expect(gs.registered()).toContain(`${CTRL}+Shift+Q`)
    expect(statusOf('stopSession')?.accelerator).toBe(`${CTRL}+Shift+Q`)
  })

  it('catches errors thrown by an action', () => {
    const { gs, actions, log } = setup()
    actions.toggleOverlay.mockImplementation(() => {
      throw new Error('boom')
    })
    expect(() => gs.press(`${CTRL}+\\`)).not.toThrow()
    expect(log.lines.some((l) => l.level === 'error')).toBe(true)
  })

  it('dispose() unregisters everything and stops reacting', () => {
    const { gs, settings, manager, broadcasts } = setup()
    manager.setOverlayVisible(true)
    const cleanup = vi.fn()
    manager.addDisposer(cleanup)
    manager.dispose()
    expect(gs.registered()).toEqual([])
    expect(cleanup).toHaveBeenCalledTimes(1)
    const calls = gs.calls.length
    const sent = broadcasts.length
    settings.update({ keybinds: { askAssist: 'Alt+Enter' } })
    manager.setOverlayVisible(false)
    manager.setOverlayFocused(true)
    manager.dispose()
    expect(gs.calls.length).toBe(calls)
    expect(broadcasts.length).toBe(sent)
    // A disposer added after dispose runs immediately.
    const late = vi.fn()
    manager.addDisposer(late)
    expect(late).toHaveBeenCalledTimes(1)
  })
})

describe('ShortcutManager capture suspension', () => {
  it('releases every global while Settings records a shortcut, then restores them', () => {
    vi.useFakeTimers()
    try {
      const { gs, manager, statusOf } = setup()
      manager.setCapturing(true)
      expect(gs.registered()).toEqual([])
      // Status keeps reporting the last real outcome while suspended.
      expect(statusOf('toggleOverlay')?.registered).toBe(true)
      manager.setCapturing(false)
      expect(gs.registered()).toEqual(DEFAULT_GLOBALS)
      // Safety net: forgetting to resume re-registers after 30 s.
      manager.setCapturing(true)
      vi.advanceTimersByTime(30_000)
      expect(gs.registered()).toEqual(DEFAULT_GLOBALS)
      manager.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
