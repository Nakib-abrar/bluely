import { describe, expect, it } from 'vitest'
import { DEFAULT_KEYBINDS, getKeybindDef } from '@shared/keybinds'
import type { KeybindStatus } from '@shared/types'
import {
  describeRebindOutcome,
  evaluateRebind,
  keybindBadge,
  labelOf,
} from '@renderer/settings/lib/rebind'

const map = { ...DEFAULT_KEYBINDS }

describe('evaluateRebind', () => {
  it('accepts a free combination and normalizes it', () => {
    expect(evaluateRebind(map, 'askAssist', 'shift+alt+k')).toEqual({
      kind: 'ok',
      accelerator: 'Alt+Shift+K',
    })
  })

  it('rejects binds without a modifier, and reserved combos', () => {
    expect(evaluateRebind(map, 'askAssist', 'K').kind).toBe('invalid')
    expect(evaluateRebind(map, 'askAssist', 'CommandOrControl+C')).toEqual({
      kind: 'reserved',
      accelerator: 'CommandOrControl+C',
    })
  })

  it('reports a same-scope conflict as an error with the other bind', () => {
    expect(evaluateRebind(map, 'askAssist', 'CommandOrControl+Shift+1')).toEqual({
      kind: 'conflict',
      accelerator: 'CommandOrControl+Shift+1',
      other: 'actionSay',
    })
  })

  it('allows a global/local overlap but flags it', () => {
    // clearChat (local) uses Ctrl+R by default.
    expect(evaluateRebind(map, 'askAssist', 'CommandOrControl+R')).toEqual({
      kind: 'focusOnly',
      accelerator: 'CommandOrControl+R',
      other: 'clearChat',
    })
  })

  it('refuses Shift-only combinations (typing / text selection in every app)', () => {
    // Pressing Shift then S before Ctrl yields "Shift+S" in capture mode.
    expect(evaluateRebind(map, 'actionSay', 'Shift+S')).toEqual({
      kind: 'invalid',
      accelerator: 'Shift+S',
      problem: 'shiftOnly',
    })
    expect(evaluateRebind(map, 'moveOverlay', 'Shift')).toMatchObject({
      kind: 'invalid',
      problem: 'shiftOnly',
    })
    expect(evaluateRebind(map, 'actionSay', 'Ctrl+Shift+S').kind).toBe('ok')
  })

  it('handles arrow families (modifier prefix only)', () => {
    expect(evaluateRebind(map, 'moveOverlay', 'Alt').kind).toBe('ok')
    expect(evaluateRebind(map, 'moveOverlay', 'Alt+K').kind).toBe('invalid')
    // scrollChat (local, Ctrl+Shift+arrows) overlaps Move's Ctrl+Shift variants only in another scope.
    expect(evaluateRebind(map, 'moveOverlay', 'CommandOrControl+Shift').kind).toBe('focusOnly')
  })

  it('ignores the bind itself (re-saving the same value is fine)', () => {
    expect(evaluateRebind(map, 'actionSay', 'CommandOrControl+Shift+1').kind).toBe('ok')
  })
})

describe('describeRebindOutcome', () => {
  const ask = getKeybindDef('askAssist')
  it('explains conflicts with the other label and display keys', () => {
    const msg = describeRebindOutcome(
      ask,
      evaluateRebind(map, 'askAssist', 'CommandOrControl+Shift+1'),
    )
    expect(msg).toEqual({
      tone: 'error',
      text: 'Ctrl+Shift+1 is already used by “What should I say?”.',
    })
  })
  it('returns an info note for focus-only overlaps and null when ok', () => {
    expect(
      describeRebindOutcome(ask, evaluateRebind(map, 'askAssist', 'CommandOrControl+R'))?.tone,
    ).toBe('info')
    expect(describeRebindOutcome(ask, { kind: 'ok', accelerator: 'Alt+K' })).toBeNull()
  })
  it('explains why Shift alone is refused', () => {
    expect(
      describeRebindOutcome(
        getKeybindDef('actionSay'),
        evaluateRebind(map, 'actionSay', 'Shift+S'),
      ),
    ).toEqual({
      tone: 'error',
      text: 'Shift+S would block typing that character in other apps. Add Ctrl, Alt or Win.',
    })
    expect(
      describeRebindOutcome(
        getKeybindDef('moveOverlay'),
        evaluateRebind(map, 'moveOverlay', 'Shift'),
      ),
    ).toEqual({
      tone: 'error',
      text: 'Shift+arrows selects text in other apps. Add Ctrl, Alt or Win.',
    })
    expect(
      describeRebindOutcome(getKeybindDef('actionSay'), evaluateRebind(map, 'actionSay', 'K'))
        ?.text,
    ).toBe('Use Ctrl, Alt or Win with a key (F-keys also work on their own).')
  })
  it('says where Shift alone gets in the way: in-app binds only fire while Bluely is focused', () => {
    expect(
      describeRebindOutcome(
        getKeybindDef('clearChat'),
        evaluateRebind(map, 'clearChat', 'Shift+R'),
      ),
    ).toEqual({
      tone: 'error',
      text: 'Shift+R would block typing that character in Bluely. Add Ctrl, Alt or Win.',
    })
    expect(
      describeRebindOutcome(
        getKeybindDef('scrollChat'),
        evaluateRebind(map, 'scrollChat', 'Shift'),
      ),
    ).toEqual({
      tone: 'error',
      text: 'Shift+arrows selects text in Bluely. Add Ctrl, Alt or Win.',
    })
  })
  it('labels binds through i18n', () => {
    expect(labelOf('toggleOverlay')).toBe('Show/hide Bluely')
  })
})

describe('keybindBadge', () => {
  const move = getKeybindDef('moveOverlay')
  const recap = getKeybindDef('actionRecap')
  const status = (s: Partial<KeybindStatus> & Pick<KeybindStatus, 'id'>): KeybindStatus => ({
    accelerator: null,
    registered: true,
    error: null,
    ...s,
  })

  it('shows nothing for Move Bluely while the overlay is hidden (inactive by design)', () => {
    // Exactly what main reports with no live session.
    const inactive = status({
      id: 'moveOverlay',
      accelerator: 'CommandOrControl',
      registered: false,
      error: null,
      reason: 'inactive',
    })
    expect(keybindBadge(move, 'CommandOrControl', inactive)).toBeNull()
    // Also when the reason is missing: no error message means no problem to show.
    expect(keybindBadge(move, 'CommandOrControl', { ...inactive, reason: undefined })).toBeNull()
  })

  it('flags binds main reports as taken, duplicated or rejected', () => {
    const taken = status({
      id: 'actionRecap',
      accelerator: 'CommandOrControl+Shift+3',
      registered: false,
      error: 'Taken by another app',
      reason: 'taken',
    })
    expect(keybindBadge(recap, 'CommandOrControl+Shift+3', taken)).toEqual({
      tone: 'warning',
      text: 'Taken by another app',
    })
    expect(
      keybindBadge(recap, 'CommandOrControl+Shift+3', { ...taken, reason: 'duplicate' }),
    ).toEqual({ tone: 'warning', text: 'Used by another Bluely shortcut' })
    expect(
      keybindBadge(recap, 'CommandOrControl+Shift+3', { ...taken, reason: 'invalid' }),
    ).toEqual({ tone: 'danger', text: 'Invalid shortcut' })
    // A status for the previous accelerator is stale: no badge until main reports the new one.
    expect(keybindBadge(recap, 'Alt+Shift+3', taken)).toBeNull()
  })

  it('marks disabled and locally invalid values without asking main', () => {
    expect(keybindBadge(recap, null, undefined)).toEqual({ tone: 'neutral', text: 'Disabled' })
    expect(keybindBadge(recap, 'Shift+3', undefined)).toEqual({
      tone: 'danger',
      text: 'Invalid shortcut',
    })
    expect(keybindBadge(recap, 'CommandOrControl+Shift+3', undefined)).toBeNull()
  })

  it('marks a hand-edited reserved value (Ctrl+C) invalid before main reports it', () => {
    const clear = getKeybindDef('clearChat')
    expect(keybindBadge(clear, 'Ctrl+C', undefined)).toEqual({
      tone: 'danger',
      text: 'Invalid shortcut',
    })
    expect(keybindBadge(recap, 'alt+f4', undefined)).toEqual({
      tone: 'danger',
      text: 'Invalid shortcut',
    })
  })
})
