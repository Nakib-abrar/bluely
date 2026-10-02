import type { EventChannel, EventPayload } from '@shared/ipc'
import type { WindowKind, WindowRegistry } from '../windows/registry'

/** Typed main → renderer push. */
export class EventBus {
  private listeners = new Map<string, Set<(payload: unknown) => void>>()

  constructor(private readonly windows: WindowRegistry) {}

  /** Sends to every open Bluely window (and in-process subscribers). */
  broadcast<E extends EventChannel>(event: E, payload: EventPayload<E>): void {
    for (const win of this.windows.all()) {
      if (!win.webContents.isDestroyed()) win.webContents.send(event, payload)
    }
    this.emitLocal(event, payload)
  }

  sendTo<E extends EventChannel>(kind: WindowKind, event: E, payload: EventPayload<E>): void {
    const win = this.windows.get(kind)
    if (win && !win.webContents.isDestroyed()) win.webContents.send(event, payload)
    this.emitLocal(event, payload)
  }

  /** In-process subscription (main-side services reacting to the same events). */
  subscribe<E extends EventChannel>(event: E, fn: (payload: EventPayload<E>) => void): () => void {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(fn as (p: unknown) => void)
    return () => set?.delete(fn as (p: unknown) => void)
  }

  private emitLocal(event: string, payload: unknown): void {
    const set = this.listeners.get(event)
    if (!set) return
    for (const fn of set) {
      try {
        fn(payload)
      } catch {
        /* a failing subscriber must not break the broadcast */
      }
    }
  }
}
