import type { GlobalShortcutApi } from '@main/shortcuts'
import type { Logger } from '@main/log'

/** In-memory stand-in for Electron's globalShortcut. */
export class FakeGlobalShortcut implements GlobalShortcutApi {
  readonly callbacks = new Map<string, () => void>()
  /** Accelerators another app holds: register() returns false. */
  readonly taken = new Set<string>()
  /** Accelerators Electron cannot parse: register() throws. */
  readonly unparsable = new Set<string>()
  /** "+Acc" for every register call, "-Acc" for every unregister call. */
  readonly calls: string[] = []

  register(accelerator: string, callback: () => void): boolean {
    this.calls.push(`+${accelerator}`)
    if (this.unparsable.has(accelerator)) throw new Error(`Failed to parse ${accelerator}`)
    if (this.taken.has(accelerator) || this.callbacks.has(accelerator)) return false
    this.callbacks.set(accelerator, callback)
    return true
  }

  unregister(accelerator: string): void {
    this.calls.push(`-${accelerator}`)
    this.callbacks.delete(accelerator)
  }

  registered(): string[] {
    return [...this.callbacks.keys()].sort()
  }

  press(accelerator: string): void {
    const cb = this.callbacks.get(accelerator)
    if (!cb) throw new Error(`${accelerator} is not registered`)
    cb()
  }
}

export interface FakeLogger extends Logger {
  lines: { level: string; message: string }[]
}

export function fakeLogger(): FakeLogger {
  const lines: { level: string; message: string }[] = []
  const make = (): FakeLogger => ({
    lines,
    debug: (message) => lines.push({ level: 'debug', message }),
    info: (message) => lines.push({ level: 'info', message }),
    warn: (message) => lines.push({ level: 'warn', message }),
    error: (message) => lines.push({ level: 'error', message }),
    child: () => make(),
    setDebug: () => undefined,
  })
  return make()
}
