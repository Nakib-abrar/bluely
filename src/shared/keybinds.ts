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

// ───────────────────────── accelerator logic (pure; used by main + Settings) ─────────────────────────

const MODIFIER_ALIASES: Record<string, string> = {
  commandorcontrol: 'CommandOrControl',
  cmdorctrl: 'CommandOrControl',
  control: 'CommandOrControl',
  ctrl: 'CommandOrControl',
  command: 'CommandOrControl',
  cmd: 'CommandOrControl',
  alt: 'Alt',
  option: 'Alt',
  altgr: 'AltGr',
  shift: 'Shift',
  super: 'Super',
  meta: 'Super',
  win: 'Super',
}
const MODIFIER_ORDER = ['CommandOrControl', 'Alt', 'AltGr', 'Shift', 'Super']

const KEY_ALIASES: Record<string, string> = {
  return: 'Enter',
  enter: 'Enter',
  esc: 'Escape',
  escape: 'Escape',
  up: 'Up',
  arrowup: 'Up',
  down: 'Down',
  arrowdown: 'Down',
  left: 'Left',
  arrowleft: 'Left',
  right: 'Right',
  arrowright: 'Right',
  space: 'Space',
  ' ': 'Space',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  plus: 'Plus',
}

const NAMED_KEYS = new Set([
  'Enter',
  'Escape',
  'Up',
  'Down',
  'Left',
  'Right',
  'Space',
  'Tab',
  'Backspace',
  'Delete',
  'Insert',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Plus',
])
const PUNCTUATION_KEYS = new Set(['\\', '/', ',', '.', ';', "'", '[', ']', '-', '=', '`'])

function canonicalKey(part: string): string | null {
  const lower = part.toLowerCase()
  if (KEY_ALIASES[lower]) return KEY_ALIASES[lower]
  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(part)) return part.toUpperCase()
  if (/^[a-z0-9]$/i.test(part)) return part.toUpperCase()
  if (PUNCTUATION_KEYS.has(part)) return part
  if (NAMED_KEYS.has(part)) return part
  return null
}

interface ParsedAccelerator {
  modifiers: string[]
  key: string | null
  valid: boolean
}

function parseAccelerator(acc: string): ParsedAccelerator {
  // "+" can itself be the key ("Ctrl+Plus" is preferred); split carefully.
  const raw = acc.trim()
  if (!raw) return { modifiers: [], key: null, valid: false }
  const parts = raw.split('+').map((p) => p.trim())
  const modifiers = new Set<string>()
  let key: string | null = null
  let valid = true
  for (const part of parts) {
    if (!part) {
      valid = false
      continue
    }
    const mod = MODIFIER_ALIASES[part.toLowerCase()]
    if (mod) {
      modifiers.add(mod)
      continue
    }
    const k = canonicalKey(part)
    if (!k || key) valid = false
    else key = k
  }
  return { modifiers: MODIFIER_ORDER.filter((m) => modifiers.has(m)), key, valid }
}

/** Canonical form: modifiers in a fixed order then the key ("Shift+ctrl+enter" → "CommandOrControl+Shift+Enter"). */
export function normalizeAccelerator(acc: string): string {
  const p = parseAccelerator(acc)
  return [...p.modifiers, ...(p.key ? [p.key] : [])].join('+')
}

/**
 * Why an accelerator cannot be used for a keybind kind:
 * - 'malformed': unknown key names, two keys, or (for single binds) no key at all.
 * - 'noModifier': a key without any modifier (only F-keys may stand alone).
 * - 'shiftOnly': Shift is the only modifier. Shift+letter/digit is ordinary typing and
 *   Shift+arrows is text selection, so binding it would swallow those keystrokes in every app.
 */
export type AcceleratorProblem = 'malformed' | 'noModifier' | 'shiftOnly'

/** Modifiers that make a combination a shortcut rather than typing (Ctrl, Alt, AltGr, Win). */
const SHORTCUT_MODIFIERS = new Set(['CommandOrControl', 'Alt', 'AltGr', 'Super'])

/** The reason `acc` is not a usable accelerator for `kind`, or null when it is fine. */
export function acceleratorProblem(acc: string, kind: KeybindKind): AcceleratorProblem | null {
  const p = parseAccelerator(acc)
  if (!p.valid) return 'malformed'
  if (kind === 'arrows4' || kind === 'arrows2') {
    // Arrow families store only the modifier prefix; the arrows are appended later.
    if (p.key !== null) return 'malformed'
  } else {
    if (!p.key) return 'malformed'
    // F-keys are not typed characters, so they may be used alone or with Shift only.
    if (/^F\d+$/.test(p.key)) return null
  }
  if (p.modifiers.length === 0) return 'noModifier'
  if (!p.modifiers.some((m) => SHORTCUT_MODIFIERS.has(m))) return 'shiftOnly'
  return null
}

/**
 * Validates an accelerator for a keybind kind. Binds need Ctrl, Alt or Win (Shift alone is
 * typing); F-keys may stand alone. Arrow families store only the modifier prefix.
 */
export function isValidAccelerator(acc: string, kind: KeybindKind): boolean {
  return acceleratorProblem(acc, kind) === null
}

/** All concrete accelerators a keybind registers (arrow families expand to their arrow keys). */
export function expandAccelerator(id: KeybindId, value: string | null): string[] {
  if (!value) return []
  const def = getKeybindDef(id)
  const base = normalizeAccelerator(value)
  if (def.kind === 'single') return [base]
  const arrows = def.kind === 'arrows4' ? ['Up', 'Down', 'Left', 'Right'] : ['Up', 'Down']
  const out = arrows.map((a) => normalizeAccelerator(`${base}+${a}`))
  // Move: Shift variants move 50 px instead of 10 px (unless Shift is already the base).
  if (def.kind === 'arrows4' && !base.split('+').includes('Shift')) {
    out.push(...arrows.map((a) => normalizeAccelerator(`${base}+Shift+${a}`)))
  }
  return out
}

export interface KeybindConflict {
  a: KeybindId
  b: KeybindId
  accelerator: string
  /**
   * 'error': both fire in the same context (must be fixed).
   * 'focus-only': a global and a local bind share keys; while Bluely is focused the local one wins
   * (the shortcut manager suspends the colliding global), elsewhere the global one fires.
   */
  severity: 'error' | 'focus-only'
}

/** Pairs of keybinds that would fire on the same key combination (disabled binds are ignored). */
export function findConflicts(map: Partial<KeybindMap>): KeybindConflict[] {
  const owners = new Map<string, KeybindId>()
  const conflicts: KeybindConflict[] = []
  const seen = new Set<string>()
  for (const def of KEYBIND_DEFS) {
    for (const acc of expandAccelerator(def.id, map[def.id] ?? null)) {
      const other = owners.get(acc)
      if (other && other !== def.id) {
        const key = [other, def.id].sort().join('|')
        if (!seen.has(key)) {
          seen.add(key)
          const severity = getKeybindDef(other).scope === def.scope ? 'error' : 'focus-only'
          conflicts.push({ a: other, b: def.id, accelerator: acc, severity })
        }
      } else {
        owners.set(acc, def.id)
      }
    }
  }
  return conflicts
}

/** Global accelerators that collide with local binds (suspended while the overlay is focused). */
export function globalsShadowedByLocals(map: Partial<KeybindMap>): string[] {
  const local = new Set(
    KEYBIND_DEFS.filter((d) => d.scope === 'local').flatMap((d) =>
      expandAccelerator(d.id, map[d.id] ?? null),
    ),
  )
  return KEYBIND_DEFS.filter((d) => d.scope === 'global')
    .flatMap((d) => expandAccelerator(d.id, map[d.id] ?? null))
    .filter((acc) => local.has(acc))
}

/** Combinations Windows (or every app) reserves; never allow binding them. */
export const RESERVED_ACCELERATORS = [
  'Alt+F4',
  'CommandOrControl+Alt+Delete',
  'Alt+Tab',
  'CommandOrControl+Escape',
  'CommandOrControl+Shift+Escape',
  'Super+L',
  'CommandOrControl+C',
  'CommandOrControl+V',
  'CommandOrControl+X',
  'CommandOrControl+Z',
  'CommandOrControl+A',
].map(normalizeAccelerator)

export function isReserved(acc: string): boolean {
  return RESERVED_ACCELERATORS.includes(normalizeAccelerator(acc))
}

/**
 * The accelerator a keybind really uses (normalized; the modifier prefix for arrow families), or
 * null when the bind does nothing: disabled, unusable for its kind (malformed, no modifier, Shift
 * only) or reserved. Main registers only these and reports the rest as "Invalid shortcut", so
 * everything else that reacts to binds (the overlay's local keys) must go through this too:
 * otherwise a hand-edited Shift+S or Ctrl+C would still fire there.
 */
export function usableAccelerator(id: KeybindId, value: string | null | undefined): string | null {
  if (value == null || value.trim() === '') return null
  const def = getKeybindDef(id)
  if (!isValidAccelerator(value, def.kind)) return null
  const normalized = normalizeAccelerator(value)
  if (def.kind === 'single' && isReserved(normalized)) return null
  return normalized
}

export interface KeyEventLike {
  key: string
  code?: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

/**
 * Converts a keydown event (from the rebind UI) to an accelerator. Returns null while only
 * modifiers are held. For arrow families any arrow press yields just the modifier prefix.
 */
export function keyEventToAccelerator(e: KeyEventLike, kind: KeybindKind): string | null {
  const mods: string[] = []
  if (e.ctrlKey) mods.push('CommandOrControl')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  if (e.metaKey) mods.push('Super')
  if (['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'OS'].includes(e.key)) return null
  const isArrow = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)
  if (kind !== 'single') {
    if (!isArrow || mods.length === 0) return null
    return normalizeAccelerator(mods.join('+'))
  }
  // Prefer the physical key for letters/digits so Shift+1 stays "1" (not "!").
  let key: string | null = null
  if (e.code && /^Key[A-Z]$/.test(e.code)) key = e.code.slice(3)
  else if (e.code && /^Digit[0-9]$/.test(e.code)) key = e.code.slice(5)
  else if (e.code === 'Backslash') key = '\\'
  else if (e.code === 'Slash') key = '/'
  else if (e.code === 'Comma') key = ','
  else if (e.code === 'Period') key = '.'
  else if (e.code === 'Semicolon') key = ';'
  else if (e.code === 'Quote') key = "'"
  else if (e.code === 'BracketLeft') key = '['
  else if (e.code === 'BracketRight') key = ']'
  else if (e.code === 'Minus') key = '-'
  else if (e.code === 'Equal') key = '='
  else if (e.code === 'Backquote') key = '`'
  else key = canonicalKey(e.key)
  if (!key) return null
  return normalizeAccelerator([...mods, key].join('+'))
}
