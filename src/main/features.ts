import type { CoreContext } from './context'

/**
 * Composition root for feature modules (providers, session, knowledge, history, …).
 * Each feature exposes a wire*() function that registers its IPC handlers and returns
 * the services other features need.
 */
export interface Features {
  isLive(): boolean
  toggleSession(): void
  /** Called once before quitting; must finish quickly. */
  shutdown(): Promise<void>
}

export function wireFeatures(_ctx: CoreContext): Features {
  return {
    isLive: () => false,
    toggleSession: () => undefined,
    shutdown: async () => undefined,
  }
}
