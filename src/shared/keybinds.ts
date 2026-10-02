/**
 * Keybind definitions shared by main (registration) and renderer (Settings › Keybinds).
 * Accelerators use Electron's syntax ("CommandOrControl+Shift+1").
 *
 * Two keybinds are "arrow families": the stored value is only the modifier prefix and
 * the arrow keys are appended (see expandAccelerator).
 */

export type KeybindId =
  | 'toggleOverlay'
  | 'askAssist'
  | 'stopSession'
  | 'moveOverlay'
  | 'actionSay'
  | 'actionFollowups'
  | 'actionRecap'
  | 'clearChat'
  | 'scrollChat'
  | 'devPanel'

export type KeybindScope = 'global' | 'local'
export type KeybindKind = 'single' | 'arrows4' | 'arrows2'

export interface KeybindDef {
  id: KeybindId
  scope: KeybindScope
  kind: KeybindKind
  defaultAccelerator: string
  /** i18n key for the label. */
  labelKey: string
}

export const KEYBIND_DEFS: readonly KeybindDef[] = [
  {
    id: 'toggleOverlay',
    scope: 'global',
    kind: 'single',
    defaultAccelerator: 'CommandOrControl+\\',
    labelKey: 'keybinds.toggleOverlay',
  },
  {
    id: 'askAssist',
    scope: 'global',
    kind: 'single',
    defaultAccelerator: 'CommandOrControl+Enter',
    labelKey: 'keybinds.askAssist',
  },
  {
    id: 'stopSession',
    scope: 'global',
    kind: 'single',
    defaultAccelerator: 'CommandOrControl+Shift+\\',
    labelKey: 'keybinds.stopSession',
  },
  {
    id: 'moveOverlay',
    scope: 'global',
    kind: 'arrows4',
    defaultAccelerator: 'CommandOrControl',
    labelKey: 'keybinds.moveOverlay',
  },
  {
    id: 'actionSay',
    scope: 'global',
    kind: 'single',
    defaultAccelerator: 'CommandOrControl+Shift+1',
    labelKey: 'keybinds.actionSay',
  },
  {
    id: 'actionFollowups',
    scope: 'global',
    kind: 'single',
    defaultAccelerator: 'CommandOrControl+Shift+2',
    labelKey: 'keybinds.actionFollowups',
  },
  {
    id: 'actionRecap',
    scope: 'global',
    kind: 'single',
    defaultAccelerator: 'CommandOrControl+Shift+3',
    labelKey: 'keybinds.actionRecap',
  },
  {
    id: 'clearChat',
    scope: 'local',
    kind: 'single',
    defaultAccelerator: 'CommandOrControl+R',
    labelKey: 'keybinds.clearChat',
  },
  {
    id: 'scrollChat',
    scope: 'local',
    kind: 'arrows2',
    defaultAccelerator: 'CommandOrControl+Shift',
    labelKey: 'keybinds.scrollChat',
  },
  {
    id: 'devPanel',
    scope: 'local',
    kind: 'single',
    defaultAccelerator: 'CommandOrControl+Shift+D',
    labelKey: 'keybinds.devPanel',
  },
] as const

export type KeybindMap = Record<KeybindId, string | null>

export const DEFAULT_KEYBINDS: KeybindMap = Object.fromEntries(
  KEYBIND_DEFS.map((d) => [d.id, d.defaultAccelerator]),
) as KeybindMap

/** One-click preset for people whose chat apps use Ctrl+Enter to send. */
export const ALT_ENTER_PRESET: Partial<KeybindMap> = { askAssist: 'Alt+Enter' }

export const KEYBIND_IDS = KEYBIND_DEFS.map((d) => d.id) as KeybindId[]

export function getKeybindDef(id: KeybindId): KeybindDef {
  const def = KEYBIND_DEFS.find((d) => d.id === id)
  if (!def) throw new Error(`Unknown keybind ${id}`)
  return def
}

const KEY_DISPLAY: Record<string, string> = {
  CommandOrControl: 'Ctrl',
  CmdOrCtrl: 'Ctrl',
  Control: 'Ctrl',
  Ctrl: 'Ctrl',
  Command: 'Cmd',
  Cmd: 'Cmd',
  Alt: 'Alt',
  Option: 'Alt',
  AltGr: 'AltGr',
  Shift: 'Shift',
  Super: 'Win',
  Meta: 'Win',
  Enter: '↵',
  Return: '↵',
  Up: '↑',
  Down: '↓',
  Left: '←',
  Right: '→',
  Space: 'Space',
  Escape: 'Esc',
  Backspace: '⌫',
  Delete: 'Del',
  Plus: '+',
}

/** Splits an accelerator into display keycaps: "CommandOrControl+Shift+Enter" → ["Ctrl","Shift","↵"]. */
export function acceleratorToKeys(accelerator: string): string[] {
  if (!accelerator) return []
  return accelerator
    .split('+')
    .filter((p) => p.length > 0)
    .map((p) => KEY_DISPLAY[p] ?? p)
}

/** Display keycaps for a keybind, including the arrow family suffix. */
export function keybindDisplay(id: KeybindId, accelerator: string | null): string[] {
  if (!accelerator) return []
  const def = getKeybindDef(id)
  const keys = acceleratorToKeys(accelerator)
  if (def.kind === 'arrows4') return [...keys, '↑↓←→']
  if (def.kind === 'arrows2') return [...keys, '↑↓']
  return keys
}
