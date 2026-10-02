import { create } from 'zustand'
import { BUILTIN_MODES } from '@shared/builtinModes'
import type { Mode } from '@shared/types'
import { invoke, on } from '../../lib/ipc'

interface ModesStore {
  /** Built-in modes until main answers, so the menu is never empty. */
  modes: Mode[]
  loaded: boolean
  ensureLoaded(): void
}

let subscribed = false

/** Modes for the "…" menu and the header chip, loaded once and kept fresh via modes:changed. */
export const useModes = create<ModesStore>((set, get) => ({
  modes: BUILTIN_MODES,
  loaded: false,
  ensureLoaded() {
    if (!subscribed) {
      subscribed = true
      on('modes:changed', (modes) => set({ modes, loaded: true }))
    }
    if (get().loaded) return
    invoke('modes:list')
      .then((modes) => set({ modes, loaded: true }))
      .catch(() => {
        // Keep the built-in list; the main side may not be ready yet.
      })
  },
}))
