import { describe, expect, it } from 'vitest'
import { DEFAULT_KEYBINDS, getKeybindDef } from '@shared/keybinds'
import { describeRebindOutcome, evaluateRebind, labelOf } from '@renderer/settings/lib/rebind'

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
  it('labels binds through i18n', () => {
    expect(labelOf('toggleOverlay')).toBe('Show/hide Bluely')
  })
})
