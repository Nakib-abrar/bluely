import { describe, expect, it } from 'vitest'
import {
  DEFAULT_KEYBINDS,
  KEYBIND_DEFS,
  acceleratorProblem,
  acceleratorToKeys,
  expandAccelerator,
  findConflicts,
  globalsShadowedByLocals,
  isReserved,
  isValidAccelerator,
  keyEventToAccelerator,
  keybindDisplay,
  normalizeAccelerator,
  usableAccelerator,
} from '@shared/keybinds'

const ev = (
  key: string,
  code: string,
  mods: Partial<{ ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }> = {},
) => ({
  key,
  code,
  ctrlKey: !!mods.ctrl,
  altKey: !!mods.alt,
  shiftKey: !!mods.shift,
  metaKey: !!mods.meta,
})

describe('keybinds', () => {
  it('normalizes aliases and modifier order', () => {
    expect(normalizeAccelerator('shift+ctrl+enter')).toBe('CommandOrControl+Shift+Enter')
    expect(normalizeAccelerator('Control+Return')).toBe('CommandOrControl+Enter')
    expect(normalizeAccelerator('CmdOrCtrl+\\')).toBe('CommandOrControl+\\')
    expect(normalizeAccelerator('alt+f4')).toBe('Alt+F4')
    expect(normalizeAccelerator('ctrl+shift+d')).toBe('CommandOrControl+Shift+D')
  })

  it('validates accelerators per kind', () => {
    expect(isValidAccelerator('CommandOrControl+Enter', 'single')).toBe(true)
    expect(isValidAccelerator('Enter', 'single')).toBe(false)
    expect(isValidAccelerator('F9', 'single')).toBe(true)
    expect(isValidAccelerator('CommandOrControl+Nope', 'single')).toBe(false)
    expect(isValidAccelerator('CommandOrControl', 'arrows4')).toBe(true)
    expect(isValidAccelerator('CommandOrControl+Up', 'arrows4')).toBe(false)
    expect(isValidAccelerator('', 'single')).toBe(false)
  })

  it('refuses Shift as the only modifier: it would swallow typing or text selection', () => {
    // Shift+letter / Shift+digit is ordinary typing in every other app.
    expect(isValidAccelerator('Shift+S', 'single')).toBe(false)
    expect(isValidAccelerator('shift+1', 'single')).toBe(false)
    expect(isValidAccelerator('Shift+Enter', 'single')).toBe(false)
    expect(acceleratorProblem('Shift+S', 'single')).toBe('shiftOnly')
    // Shift+arrows is text selection.
    expect(isValidAccelerator('Shift', 'arrows4')).toBe(false)
    expect(acceleratorProblem('Shift', 'arrows2')).toBe('shiftOnly')
    // With Ctrl, Alt or Win it is a shortcut; F-keys may go alone or with Shift only.
    expect(isValidAccelerator('CommandOrControl+Shift+S', 'single')).toBe(true)
    expect(isValidAccelerator('Alt+Shift+S', 'single')).toBe(true)
    expect(isValidAccelerator('Super+Shift+S', 'single')).toBe(true)
    expect(isValidAccelerator('Shift+F7', 'single')).toBe(true)
    expect(isValidAccelerator('Alt+Shift', 'arrows4')).toBe(true)
    // Other problems keep their own reason.
    expect(acceleratorProblem('S', 'single')).toBe('noModifier')
    expect(acceleratorProblem('Ctrl+Nope', 'single')).toBe('malformed')
    expect(acceleratorProblem('Ctrl', 'single')).toBe('malformed')
    expect(acceleratorProblem('', 'arrows4')).toBe('malformed')
    expect(acceleratorProblem('Ctrl+Up', 'arrows4')).toBe('malformed')
    expect(acceleratorProblem('CommandOrControl+Enter', 'single')).toBeNull()
  })

  it('accepts every default bind', () => {
    for (const def of KEYBIND_DEFS) {
      expect(isValidAccelerator(def.defaultAccelerator, def.kind), def.id).toBe(true)
    }
  })

  it('expands arrow families', () => {
    expect(expandAccelerator('moveOverlay', 'CommandOrControl')).toEqual([
      'CommandOrControl+Up',
      'CommandOrControl+Down',
      'CommandOrControl+Left',
      'CommandOrControl+Right',
      'CommandOrControl+Shift+Up',
      'CommandOrControl+Shift+Down',
      'CommandOrControl+Shift+Left',
      'CommandOrControl+Shift+Right',
    ])
    expect(expandAccelerator('scrollChat', 'CommandOrControl+Shift')).toEqual([
      'CommandOrControl+Shift+Up',
      'CommandOrControl+Shift+Down',
    ])
    expect(expandAccelerator('toggleOverlay', null)).toEqual([])
  })

  it('finds conflicts, including arrow-family overlaps', () => {
    // Default: moveOverlay's Shift variants overlap scrollChat (global vs local): focus-only by design.
    const defaults = findConflicts(DEFAULT_KEYBINDS)
    expect(defaults).toEqual([
      {
        a: 'moveOverlay',
        b: 'scrollChat',
        accelerator: 'CommandOrControl+Shift+Up',
        severity: 'focus-only',
      },
    ])
    expect(globalsShadowedByLocals(DEFAULT_KEYBINDS)).toEqual([
      'CommandOrControl+Shift+Up',
      'CommandOrControl+Shift+Down',
    ])
    const clash = findConflicts({ ...DEFAULT_KEYBINDS, actionSay: 'Ctrl+Enter' })
    expect(clash).toContainEqual({
      a: 'askAssist',
      b: 'actionSay',
      accelerator: 'CommandOrControl+Enter',
      severity: 'error',
    })
    expect(findConflicts({ ...DEFAULT_KEYBINDS, actionSay: null, scrollChat: null })).toEqual([])
  })

  it('converts key events from the rebind UI', () => {
    expect(keyEventToAccelerator(ev('Enter', 'Enter', { ctrl: true }), 'single')).toBe(
      'CommandOrControl+Enter',
    )
    expect(keyEventToAccelerator(ev('!', 'Digit1', { ctrl: true, shift: true }), 'single')).toBe(
      'CommandOrControl+Shift+1',
    )
    expect(keyEventToAccelerator(ev('\\', 'Backslash', { ctrl: true }), 'single')).toBe(
      'CommandOrControl+\\',
    )
    expect(keyEventToAccelerator(ev('Control', 'ControlLeft', { ctrl: true }), 'single')).toBeNull()
    expect(keyEventToAccelerator(ev('ArrowUp', 'ArrowUp', { alt: true }), 'arrows4')).toBe('Alt')
    expect(keyEventToAccelerator(ev('a', 'KeyA'), 'arrows4')).toBeNull()
  })

  it('usableAccelerator: what a bind really fires on (null when it does nothing)', () => {
    // Every default is usable as-is.
    for (const def of KEYBIND_DEFS) {
      expect(usableAccelerator(def.id, def.defaultAccelerator), def.id).toBe(
        normalizeAccelerator(def.defaultAccelerator),
      )
    }
    expect(usableAccelerator('clearChat', 'ctrl+r')).toBe('CommandOrControl+R')
    expect(usableAccelerator('scrollChat', 'alt+ctrl')).toBe('CommandOrControl+Alt')
    expect(usableAccelerator('devPanel', 'F9')).toBe('F9')
    // Disabled.
    expect(usableAccelerator('clearChat', null)).toBeNull()
    expect(usableAccelerator('clearChat', undefined)).toBeNull()
    expect(usableAccelerator('clearChat', '  ')).toBeNull()
    // Hand-edited values Settings refuses: local binds must not fire on them either.
    expect(usableAccelerator('clearChat', 'Shift+R')).toBeNull() // capital R while typing
    expect(usableAccelerator('askAssist', 'Shift+Enter')).toBeNull() // new line while typing
    expect(usableAccelerator('scrollChat', 'Shift')).toBeNull() // text selection
    expect(usableAccelerator('devPanel', 'D')).toBeNull()
    expect(usableAccelerator('devPanel', 'Ctrl+Nope')).toBeNull()
    // Reserved combos (copy, select all...) never become binds, local or global.
    expect(usableAccelerator('clearChat', 'Ctrl+C')).toBeNull()
    expect(usableAccelerator('devPanel', 'ctrl+a')).toBeNull()
    expect(usableAccelerator('actionRecap', 'Alt+F4')).toBeNull()
    // Wrong shape for the kind.
    expect(usableAccelerator('moveOverlay', 'Ctrl+Up')).toBeNull()
    expect(usableAccelerator('clearChat', 'Ctrl')).toBeNull()
  })

  it('flags reserved combos and formats keycaps', () => {
    expect(isReserved('alt+F4')).toBe(true)
    expect(isReserved('Ctrl+Enter')).toBe(false)
    expect(acceleratorToKeys('CommandOrControl+Enter')).toEqual(['Ctrl', '↵'])
    expect(keybindDisplay('moveOverlay', 'CommandOrControl')).toEqual(['Ctrl', '↑↓←→'])
  })
})
