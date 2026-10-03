/**
 * Decides what happens when the user presses a new shortcut in Settings › Keybinds (or applies the
 * Alt+Enter preset). Pure (unit-tested): the pages only render the outcome.
 */
import { t, type MessageKey } from '@shared/i18n'
import {
  acceleratorProblem,
  acceleratorToKeys,
  findConflicts,
  getKeybindDef,
  isReserved,
  normalizeAccelerator,
  usableAccelerator,
  type AcceleratorProblem,
  type KeybindDef,
  type KeybindId,
  type KeybindMap,
} from '@shared/keybinds'
import type { KeybindStatus } from '@shared/types'

export type RebindOutcome =
  | { kind: 'invalid'; accelerator: string; problem: AcceleratorProblem }
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
  const problem = acceleratorProblem(accelerator, def.kind)
  if (problem) return { kind: 'invalid', accelerator, problem }
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
      if (outcome.problem === 'shiftOnly') {
        return {
          tone: 'error',
          text:
            def.kind === 'single'
              ? t('settings.keybinds.errShiftOnly', { keys: keysText(outcome.accelerator) })
              : t('settings.keybinds.errShiftOnlyArrows'),
        }
      }
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

export interface KeybindBadge {
  tone: 'neutral' | 'warning' | 'danger'
  text: string
}

/**
 * The status badge of a Settings › Keybinds row. Only problems main actually reports are shown:
 * a bind that is not registered on purpose (Move Bluely while the overlay is hidden, globals
 * suspended while recording) carries reason 'inactive' and gets no badge.
 */
export function keybindBadge(
  def: KeybindDef,
  value: string | null,
  status: KeybindStatus | undefined,
): KeybindBadge | null {
  if (value == null) return { tone: 'neutral', text: t('settings.keybinds.disabled') }
  // Unusable values (including reserved ones like Ctrl+C) do nothing anywhere: say so before
  // main's status arrives.
  if (usableAccelerator(def.id, value) === null) {
    return { tone: 'danger', text: t('settings.keybinds.invalid') }
  }
  // A status for another accelerator is stale (main has not applied the new value yet).
  if (
    !status ||
    status.accelerator == null ||
    normalizeAccelerator(status.accelerator) !== normalizeAccelerator(value)
  ) {
    return null
  }
  switch (status.reason) {
    case 'taken':
      return { tone: 'warning', text: t('settings.keybinds.taken') }
    case 'duplicate':
      return { tone: 'warning', text: t('keybinds.duplicate') }
    case 'invalid':
      return { tone: 'danger', text: t('settings.keybinds.invalid') }
    case undefined:
      // `reason` is optional in the contract: trust only an explicit error message then.
      return !status.registered && status.error ? { tone: 'warning', text: status.error } : null
    default:
      return null
  }
}
