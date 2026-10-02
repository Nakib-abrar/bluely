import { describe, expect, it } from 'vitest'
import {
  DEFAULT_KEYBINDS,
  acceleratorToKeys,
  expandAccelerator,
  findConflicts,
  globalsShadowedByLocals,
  isReserved,
  isValidAccelerator,
  keyEventToAccelerator,
  keybindDisplay,
  normalizeAccelerator,
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

  it('flags reserved combos and formats keycaps', () => {
    expect(isReserved('alt+F4')).toBe(true)
    expect(isReserved('Ctrl+Enter')).toBe(false)
    expect(acceleratorToKeys('CommandOrControl+Enter')).toEqual(['Ctrl', '↵'])
    expect(keybindDisplay('moveOverlay', 'CommandOrControl')).toEqual(['Ctrl', '↑↓←→'])
  })
})
