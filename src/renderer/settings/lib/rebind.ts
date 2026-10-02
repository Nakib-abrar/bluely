/**
 * Decides what happens when the user presses a new shortcut in Settings › Keybinds (or applies the
 * Alt+Enter preset). Pure (unit-tested): the pages only render the outcome.
 */
import { t, type MessageKey } from '@shared/i18n'
import {
  acceleratorToKeys,
  findConflicts,
  getKeybindDef,
  isReserved,
  isValidAccelerator,
  normalizeAccelerator,
  type KeybindDef,
  type KeybindId,
  type KeybindMap,
} from '@shared/keybinds'

export type RebindOutcome =
  | { kind: 'invalid'; accelerator: string }
  | { kind: 'reserved'; accelerator: string }
  | { kind: 'conflict'; accelerator: string; other: KeybindId }
  /** Saved, but shares keys with a bind of the other scope (the local one wins while Bluely is focused). */
  | { kind: 'focusOnly'; accelerator: string; other: KeybindId }
  | { kind: 'ok'; accelerator: string }

export function evaluateRebind(
  current: KeybindMap,
  id: KeybindId,
  accelerator: string,
): RebindOutcome {
  const def = getKeybindDef(id)
  if (!isValidAccelerator(accelerator, def.kind)) return { kind: 'invalid', accelerator }
  const normalized = normalizeAccelerator(accelerator)
  if (def.kind === 'single' && isReserved(normalized)) {
    return { kind: 'reserved', accelerator: normalized }
  }
  const conflicts = findConflicts({ ...current, [id]: normalized }).filter(
    (c) => c.a === id || c.b === id,
  )
  const hard = conflicts.find((c) => c.severity === 'error')
  if (hard) {
    return { kind: 'conflict', accelerator: normalized, other: hard.a === id ? hard.b : hard.a }
  }
  const soft = conflicts[0]
  if (soft) {
    return { kind: 'focusOnly', accelerator: normalized, other: soft.a === id ? soft.b : soft.a }
  }
  return { kind: 'ok', accelerator: normalized }
}

export interface RowMessage {
  tone: 'error' | 'info'
  text: string
}

/** Translated label of a keybind ("Ask Bluely / Assist"). */
export function labelOf(id: KeybindId): string {
  return t(getKeybindDef(id).labelKey as MessageKey)
}

function keysText(accelerator: string): string {
  return acceleratorToKeys(accelerator).join('+')
}

/** Inline message for a rebind outcome, or null when it saved cleanly. */
export function describeRebindOutcome(def: KeybindDef, outcome: RebindOutcome): RowMessage | null {
  switch (outcome.kind) {
    case 'invalid':
      return {
        tone: 'error',
        text:
          def.kind === 'single'
            ? t('settings.keybinds.errInvalid')
            : t('settings.keybinds.errInvalidArrows'),
      }
    case 'reserved':
      return {
        tone: 'error',
        text: t('settings.keybinds.errReserved', { keys: keysText(outcome.accelerator) }),
      }
    case 'conflict':
      return {
        tone: 'error',
        text: t('settings.keybinds.errConflict', {
          keys: keysText(outcome.accelerator),
          other: labelOf(outcome.other),
        }),
      }
    case 'focusOnly':
      return {
        tone: 'info',
        text: t('settings.keybinds.infoFocusOnly', { other: labelOf(outcome.other) }),
      }
    default:
      return null
  }
}
