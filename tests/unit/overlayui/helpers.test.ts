import { describe, expect, it } from 'vitest'
import { DEFAULT_KEYBINDS, type KeybindMap } from '@shared/keybinds'
import { matchLocalKey } from '../../../src/renderer/overlay/hooks/useOverlayKeys'
import { levelToScale } from '../../../src/renderer/overlay/lib/levels'
import { formatOffset, stageSeconds } from '../../../src/renderer/overlay/lib/time'

function key(
  k: string,
  code: string,
  mods: Partial<{ ctrl: boolean; shift: boolean; alt: boolean; meta: boolean }> = {},
) {
  return {
    key: k,
    code,
    ctrlKey: !!mods.ctrl,
    shiftKey: !!mods.shift,
    altKey: !!mods.alt,
    metaKey: !!mods.meta,
  }
}

describe('matchLocalKey', () => {
  const binds: KeybindMap = { ...DEFAULT_KEYBINDS }

  it('matches the default local binds', () => {
    expect(matchLocalKey(key('r', 'KeyR', { ctrl: true }), binds)).toEqual({ type: 'clearChat' })
    expect(matchLocalKey(key('D', 'KeyD', { ctrl: true, shift: true }), binds)).toEqual({
      type: 'devPanel',
    })
    expect(matchLocalKey(key('Enter', 'Enter', { ctrl: true }), binds)).toEqual({
      type: 'assist',
    })
    expect(matchLocalKey(key('ArrowUp', 'ArrowUp', { ctrl: true, shift: true }), binds)).toEqual({
      type: 'scroll',
      direction: 'up',
    })
    expect(
      matchLocalKey(key('ArrowDown', 'ArrowDown', { ctrl: true, shift: true }), binds),
    ).toEqual({ type: 'scroll', direction: 'down' })
  })

  it('ignores plain typing and near misses', () => {
    expect(matchLocalKey(key('r', 'KeyR'), binds)).toBeNull()
    expect(matchLocalKey(key('Enter', 'Enter'), binds)).toBeNull()
    expect(matchLocalKey(key('R', 'KeyR', { ctrl: true, shift: true }), binds)).toBeNull()
    expect(matchLocalKey(key('ArrowUp', 'ArrowUp', { ctrl: true }), binds)).toBeNull()
    expect(matchLocalKey(key('Control', 'ControlLeft', { ctrl: true }), binds)).toBeNull()
  })

  it('follows rebinding and disabled binds', () => {
    const custom: KeybindMap = {
      ...binds,
      clearChat: null,
      askAssist: 'Alt+Enter',
      scrollChat: 'Alt',
    }
    expect(matchLocalKey(key('r', 'KeyR', { ctrl: true }), custom)).toBeNull()
    expect(matchLocalKey(key('Enter', 'Enter', { ctrl: true }), custom)).toBeNull()
    expect(matchLocalKey(key('Enter', 'Enter', { alt: true }), custom)).toEqual({ type: 'assist' })
    expect(matchLocalKey(key('ArrowDown', 'ArrowDown', { alt: true }), custom)).toEqual({
      type: 'scroll',
      direction: 'down',
    })
  })
})

describe('time helpers', () => {
  it('formats session offsets as mm:ss', () => {
    expect(formatOffset(0)).toBe('00:00')
    expect(formatOffset(12_400)).toBe('00:12')
    expect(formatOffset(72_000)).toBe('01:12')
    expect(formatOffset(3_723_000)).toBe('1:02:03')
    expect(formatOffset(-5)).toBe('00:00')
    expect(formatOffset(Number.NaN)).toBe('00:00')
  })

  it('computes stage durations in seconds', () => {
    expect(stageSeconds(1000, 1420)).toBeCloseTo(0.42)
    expect(stageSeconds(null, 5)).toBeNull()
    expect(stageSeconds(5, null)).toBeNull()
    expect(stageSeconds(10, 5)).toBe(0)
  })
})

describe('levelToScale', () => {
  it('maps RMS to a 0..1 bar scale', () => {
    expect(levelToScale(0)).toBe(0)
    expect(levelToScale(-1)).toBe(0)
    expect(levelToScale(Number.NaN)).toBe(0)
    expect(levelToScale(0.01)).toBeCloseTo(0.22)
    expect(levelToScale(1)).toBe(1)
  })
})
