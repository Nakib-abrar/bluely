/**
 * Global keyboard shortcuts (Electron globalShortcut).
 *
 * - Every `scope: 'global'` keybind from settings is registered; `null` disables a bind.
 * - Move-overlay (Ctrl+Arrows) is registered only while the overlay is visible, because
 *   Ctrl+Arrow is word navigation in every other app.
 * - While the overlay is focused, globals that collide with the overlay's local binds
 *   (Ctrl+Shift+↑/↓ scroll) are released so the overlay sees the keystroke, and re-registered
 *   on blur.
 * - Changes are applied as a diff: unchanged accelerators stay registered, so another app never
 *   gets a window to grab them during a re-register.
 * - Status per bind is broadcast as 'keybinds:status' for Settings › Keybinds.
 */
import { app, globalShortcut as electronGlobalShortcut, type BrowserWindow } from 'electron'
import { OVERLAY } from '@shared/constants'
import { t } from '@shared/i18n'
import {
  KEYBIND_DEFS,
  expandAccelerator,
  globalsShadowedByLocals,
  isReserved,
  isValidAccelerator,
  normalizeAccelerator,
  type KeybindDef,
  type KeybindId,
  type KeybindMap,
} from '@shared/keybinds'
import type { KeybindStatus } from '@shared/types'
import type { CoreContext } from './context'
import type { EventBus } from './ipc/events'
import { handle } from './ipc/registry'
import type { Logger } from './log'
import type { SettingsStore } from './settings/settingsStore'

export interface ShortcutActions {
  toggleOverlay(): void
  askAssist(): void
  stopSession(): void
  moveOverlay(dx: number, dy: number): void
  runAction(a: 'say' | 'followups' | 'recap'): void
}

/** The subset of Electron's globalShortcut the manager uses (injectable for tests). */
export interface GlobalShortcutApi {
  register(accelerator: string, callback: () => void): boolean
  unregister(accelerator: string): void
}

export interface ShortcutManagerDeps {
  settings: Pick<SettingsStore, 'get' | 'onChange'>
  events: Pick<EventBus, 'broadcast'>
  log: Logger
  actions: ShortcutActions
  globalShortcut?: GlobalShortcutApi
}

/** Status texts shown in Settings › Keybinds (one per KeybindStatus reason that is a problem). */
export const KEYBIND_STATUS_ERRORS = {
  get taken(): string {
    return t('keybinds.taken')
  },
  get invalid(): string {
    return t('keybinds.invalid')
  },
  get duplicate(): string {
    return t('keybinds.duplicate')
  },
  get disabled(): string {
    return t('common.disabled')
  },
} as const

type AttemptResult = 'ok' | 'taken' | 'invalid'

interface Binding {
  bindId: KeybindId
  accelerator: string
  /** Identifies what the callback does, so a remapped accelerator gets a fresh callback. */
  key: string
  run: () => void
}

interface BindPlan {
  def: KeybindDef
  value: string | null
  state: 'disabled' | 'invalid' | 'ok'
  bindings: Binding[]
}

/** Unit direction per arrow key; multiplied by the step size. */
const ARROWS: Readonly<Record<string, readonly [number, number]>> = {
  Up: [0, -1],
  Down: [0, 1],
  Left: [-1, 0],
  Right: [1, 0],
}

function sameKeybinds(a: KeybindMap, b: KeybindMap): boolean {
  return KEYBIND_DEFS.every((d) => (a[d.id] ?? null) === (b[d.id] ?? null))
}

export class ShortcutManager {
  private readonly gs: GlobalShortcutApi
  private readonly log: Logger
  /** Accelerators currently registered by us → binding key. */
  private readonly active = new Map<string, string>()
  /** Last registration outcome per accelerator (kept while suspended for focus). */
  private readonly lastResult = new Map<string, AttemptResult>()
  private readonly disposers: (() => void)[] = []
  private overlayVisible = false
  private overlayFocused = false
  private capturing = false
  private captureTimer: NodeJS.Timeout | null = null
  private disposed = false
  private current: KeybindStatus[] = []
  private lastBroadcast = ''

  constructor(private readonly deps: ShortcutManagerDeps) {
    this.gs = deps.globalShortcut ?? electronGlobalShortcut
    this.log = deps.log
    this.disposers.push(
      deps.settings.onChange((next, prev) => {
        if (!sameKeybinds(next.keybinds, prev.keybinds)) this.apply(true)
      }),
    )
    this.apply(true)
  }

  /** Move-overlay binds exist only while the overlay is on screen. */
  setOverlayVisible(visible: boolean): void {
    if (this.disposed) return
    const focused = visible && this.overlayFocused
    if (visible === this.overlayVisible && focused === this.overlayFocused) return
    this.overlayVisible = visible
    this.overlayFocused = focused
    this.apply(false)
  }

  /** While focused, globals shadowed by the overlay's local binds are released. */
  setOverlayFocused(focused: boolean): void {
    if (this.disposed || focused === this.overlayFocused) return
    this.overlayFocused = focused
    this.apply(false)
  }

  /**
   * While Settings › Keybinds records a new shortcut, every global is released so the OS
   * doesn't swallow combinations Bluely already owns. Auto-resumes after 30 s as a safety net.
   */
  setCapturing(active: boolean): void {
    if (this.disposed) return
    if (this.captureTimer) clearTimeout(this.captureTimer)
    this.captureTimer = active ? setTimeout(() => this.setCapturing(false), 30_000) : null
    if (active === this.capturing) return
    this.capturing = active
    this.apply(false)
  }

  status(): KeybindStatus[] {
    return this.current.map((s) => ({ ...s }))
  }

  /** Runs `fn` on dispose (used by wireShortcuts for its listeners). */
  addDisposer(fn: () => void): void {
    if (this.disposed) fn()
    else this.disposers.push(fn)
  }

  /** Unregisters every shortcut Bluely holds. Call on quit. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.captureTimer) clearTimeout(this.captureTimer)
    for (const acc of this.active.keys()) this.safeUnregister(acc)
    this.active.clear()
    for (const fn of this.disposers.splice(0)) {
      try {
        fn()
      } catch (err) {
        this.log.warn('Shortcut cleanup failed', err)
      }
    }
  }

  private plan(keybinds: KeybindMap): BindPlan[] {
    return KEYBIND_DEFS.map((def) => {
      const value = keybinds[def.id] ?? null
      if (value === null || value.trim() === '') {
        return { def, value: null, state: 'disabled', bindings: [] }
      }
      if (!isValidAccelerator(value, def.kind) || (def.kind === 'single' && isReserved(value))) {
        return { def, value, state: 'invalid', bindings: [] }
      }
      const normalized = normalizeAccelerator(value)
      return {
        def,
        value: normalized,
        state: 'ok',
        bindings: def.scope === 'global' ? this.bindingsFor(def.id, normalized) : [],
      }
    })
  }

  private bindingsFor(id: KeybindId, value: string): Binding[] {
    const a = this.deps.actions
    const single = (key: string, run: () => void): Binding[] =>
      expandAccelerator(id, value).map((accelerator) => ({ bindId: id, accelerator, key, run }))
    switch (id) {
      case 'toggleOverlay':
        return single(id, () => a.toggleOverlay())
      case 'askAssist':
        return single(id, () => a.askAssist())
      case 'stopSession':
        return single(id, () => a.stopSession())
      case 'actionSay':
        return single(id, () => a.runAction('say'))
      case 'actionFollowups':
        return single(id, () => a.runAction('followups'))
      case 'actionRecap':
        return single(id, () => a.runAction('recap'))
      case 'moveOverlay': {
        // expandAccelerator adds Shift variants unless Shift is already in the base; those move 50 px.
        const small = new Set(
          Object.keys(ARROWS).map((arrow) => normalizeAccelerator(`${value}+${arrow}`)),
        )
        return expandAccelerator(id, value).flatMap((accelerator) => {
          const dir = ARROWS[accelerator.split('+').pop() ?? '']
          if (!dir) return []
          const step = small.has(accelerator) ? OVERLAY.moveStepPx : OVERLAY.moveStepLargePx
          const [dx, dy] = [dir[0] * step, dir[1] * step]
          return [
            { bindId: id, accelerator, key: `${id}:${dx}:${dy}`, run: () => a.moveOverlay(dx, dy) },
          ]
        })
      }
      default:
        this.log.warn(`No global action for keybind ${id}`)
        return []
    }
  }

  private apply(forceBroadcast: boolean): void {
    if (this.disposed) return
    const keybinds = this.deps.settings.get().keybinds
    const plans = this.plan(keybinds)
    const shadowed = new Set(
      this.capturing
        ? plans.flatMap((p) => p.bindings.map((b) => b.accelerator))
        : this.overlayFocused
          ? globalsShadowedByLocals(keybinds)
          : [],
    )

    // What should be registered right now. The first bind (KEYBIND_DEFS order) owns a duplicate.
    const want = new Map<string, Binding>()
    const duplicates = new Set<string>()
    for (const p of plans) {
      if (p.state !== 'ok' || !this.isActive(p.def.id)) continue
      for (const b of p.bindings) {
        if (shadowed.has(b.accelerator)) continue
        if (want.has(b.accelerator)) duplicates.add(`${p.def.id}|${b.accelerator}`)
        else want.set(b.accelerator, b)
      }
    }

    for (const [acc, key] of [...this.active]) {
      if (want.get(acc)?.key !== key) {
        this.safeUnregister(acc)
        this.active.delete(acc)
      }
    }
    for (const [acc, b] of want) {
      if (this.active.has(acc)) continue
      const result = this.tryRegister(b)
      if (result === 'ok') this.active.set(acc, b.key)
      if (this.lastResult.get(acc) !== result) {
        if (result === 'taken') this.log.warn(`Shortcut ${acc} is taken by another app`)
        if (result === 'invalid') this.log.warn(`Shortcut ${acc} was rejected as invalid`)
      }
      this.lastResult.set(acc, result)
    }

    // Forget outcomes for accelerators no bind uses any more.
    const known = new Set(plans.flatMap((p) => p.bindings.map((b) => b.accelerator)))
    for (const acc of [...this.lastResult.keys()]) if (!known.has(acc)) this.lastResult.delete(acc)

    this.current = plans.map((p) => this.statusFor(p, shadowed, duplicates))
    const serialized = JSON.stringify(this.current)
    if (forceBroadcast || serialized !== this.lastBroadcast) {
      this.lastBroadcast = serialized
      this.deps.events.broadcast('keybinds:status', this.status())
    }
  }

  private isActive(id: KeybindId): boolean {
    return id !== 'moveOverlay' || this.overlayVisible
  }

  private statusFor(p: BindPlan, shadowed: Set<string>, duplicates: Set<string>): KeybindStatus {
    const base = { id: p.def.id, accelerator: p.value }
    if (p.state === 'disabled') {
      return {
        ...base,
        registered: false,
        error: KEYBIND_STATUS_ERRORS.disabled,
        reason: 'disabled',
      }
    }
    if (p.state === 'invalid') {
      return { ...base, registered: false, error: KEYBIND_STATUS_ERRORS.invalid, reason: 'invalid' }
    }
    // Local binds are handled by the overlay renderer.
    if (p.def.scope === 'local') return { ...base, registered: true, error: null, reason: null }
    // Move-overlay while the overlay is hidden: inactive by design, not an error.
    if (!this.isActive(p.def.id)) {
      return { ...base, registered: false, error: null, reason: 'inactive' }
    }

    let registered = p.bindings.length > 0
    let reason: KeybindStatus['reason'] = null
    for (const b of p.bindings) {
      if (duplicates.has(`${p.def.id}|${b.accelerator}`)) {
        registered = false
        reason ??= 'duplicate'
        continue
      }
      // Suspended while the overlay is focused: report how it was before suspension.
      const result = this.active.has(b.accelerator)
        ? 'ok'
        : shadowed.has(b.accelerator)
          ? (this.lastResult.get(b.accelerator) ?? null)
          : (this.lastResult.get(b.accelerator) ?? 'taken')
      if (result === 'ok') continue
      registered = false
      // Another app holding the keys is the most actionable problem, so it wins.
      if (result === 'taken') reason = 'taken'
      else if (result === 'invalid') reason ??= 'invalid'
    }
    // Not registered without a problem: suspended (focus or capture) before it was ever tried.
    if (!registered && reason === null) reason = 'inactive'
    const error = reason === null || reason === 'inactive' ? null : KEYBIND_STATUS_ERRORS[reason]
    return { ...base, registered, error, reason }
  }

  private tryRegister(b: Binding): AttemptResult {
    try {
      const ok = this.gs.register(b.accelerator, () => {
        try {
          b.run()
        } catch (err) {
          this.log.error(`Shortcut ${b.bindId} failed`, err)
        }
      })
      return ok ? 'ok' : 'taken'
    } catch (err) {
      // Electron throws for accelerators it cannot parse.
      this.log.warn(`Could not register ${b.accelerator}`, err)
      return 'invalid'
    }
  }

  private safeUnregister(acc: string): void {
    try {
      this.gs.unregister(acc)
    } catch (err) {
      this.log.warn(`Could not unregister ${acc}`, err)
    }
  }
}

/**
 * Creates the shortcut manager, serves 'keybinds:getStatus', and follows the overlay's
 * visibility ('overlay:visibility') and focus. Focus is tracked through the app-level
 * 'browser-window-focus' / 'browser-window-blur' events filtered to the overlay window: they
 * also cover an overlay window created after startup, or shown via overlay.focus() (which does
 * not broadcast visibility).
 */
export function wireShortcuts(ctx: CoreContext, actions: ShortcutActions): ShortcutManager {
  const manager = new ShortcutManager({
    settings: ctx.settings,
    events: ctx.events,
    log: ctx.log.child('shortcuts'),
    actions,
  })
  handle('keybinds:getStatus', () => manager.status())
  handle('keybinds:setCapturing', ({ active }) => manager.setCapturing(active))

  const isOverlay = (win: BrowserWindow) => win === ctx.overlay.window
  const onFocus = (_event: unknown, win: BrowserWindow) => {
    if (!isOverlay(win)) return
    manager.setOverlayVisible(ctx.overlay.isVisible())
    manager.setOverlayFocused(true)
  }
  const onBlur = (_event: unknown, win: BrowserWindow) => {
    if (isOverlay(win)) manager.setOverlayFocused(false)
  }
  const onWillQuit = () => manager.dispose()
  app.on('browser-window-focus', onFocus)
  app.on('browser-window-blur', onBlur)
  app.on('will-quit', onWillQuit)
  const unsubscribe = ctx.events.subscribe('overlay:visibility', ({ visible }) => {
    manager.setOverlayVisible(visible)
    const win = ctx.overlay.window
    manager.setOverlayFocused(visible && !!win && win.isFocused())
  })
  manager.addDisposer(() => {
    unsubscribe()
    app.removeListener('browser-window-focus', onFocus)
    app.removeListener('browser-window-blur', onBlur)
    app.removeListener('will-quit', onWillQuit)
  })

  const win = ctx.overlay.window
  manager.setOverlayVisible(ctx.overlay.isVisible())
  manager.setOverlayFocused(ctx.overlay.isVisible() && !!win && win.isFocused())
  return manager
}
