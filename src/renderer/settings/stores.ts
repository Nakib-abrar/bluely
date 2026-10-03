/**
 * Small shared caches for the settings UI: the OpenRouter model catalog (several pickers share one
 * request) and the Mode list (kept fresh by the modes:changed event).
 */
import { create } from 'zustand'
import type { Mode, ModelInfo } from '@shared/types'
import { invoke, on } from '../lib/ipc'
import { useSettings } from '../stores/settings'
import { describeError } from './lib/errors'

type LoadStatus = 'idle' | 'loading' | 'ready' | 'error'

interface ModelCatalogState {
  models: ModelInfo[]
  status: LoadStatus
  error: string | null
  load: (opts?: { refresh?: boolean }) => Promise<void>
}

let catalogRequest: Promise<void> | null = null

export const useModelCatalog = create<ModelCatalogState>((set) => ({
  models: [],
  status: 'idle',
  error: null,
  load: (opts = {}) => {
    // Share an in-flight request unless the user explicitly asked for a refresh.
    if (catalogRequest && !opts.refresh) return catalogRequest
    set({ status: 'loading', error: null })
    const request = invoke('models:list', opts.refresh ? { refresh: true } : {})
      .then((models) => set({ models, status: 'ready', error: null }))
      .catch((err: unknown) => set({ status: 'error', error: describeError(err) }))
      .finally(() => {
        if (catalogRequest === request) catalogRequest = null
      })
    catalogRequest = request
    return request
  },
}))

interface ModesState {
  modes: Mode[]
  status: LoadStatus
  error: string | null
  /**
   * The Mode the user just made active, relative to the settings value it replaced. Main updates
   * settings.activeModeId too; this only bridges the gap until that echo arrives. It is dropped
   * as soon as settings.activeModeId moves off `base` (the echo, or a switch made elsewhere such
   * as the header Mode pill), so it can never resurface when the active Mode later returns to
   * `base`.
   */
  activeChoice: ActiveChoice | null
  load: () => Promise<void>
  upsert: (mode: Mode) => void
  remove: (id: string) => void
  /** Makes a Mode active (optimistic). Rejects with the IPC error when main refuses. */
  setActive: (id: string) => Promise<void>
}

interface ActiveChoice {
  id: string
  base: string
}

let modesSubscribed = false
let settingsWatched = false

/** Drops the optimistic choice once settings no longer hold the value it was made against. */
function watchSettingsForChoice(): void {
  if (settingsWatched) return
  settingsWatched = true
  useSettings.subscribe((state) => {
    const choice = useModes.getState().activeChoice
    if (choice && state.settings.activeModeId !== choice.base) {
      useModes.setState({ activeChoice: null })
    }
  })
}

export const useModes = create<ModesState>((set, get) => ({
  modes: [],
  status: 'idle',
  error: null,
  activeChoice: null,
  load: async () => {
    if (!modesSubscribed) {
      modesSubscribed = true
      on('modes:changed', (modes) => set({ modes: sortModes(modes), status: 'ready', error: null }))
    }
    set((s) => ({ status: s.modes.length ? s.status : 'loading', error: null }))
    try {
      const modes = await invoke('modes:list')
      set({ modes: sortModes(modes), status: 'ready', error: null })
    } catch (err) {
      set({ status: 'error', error: describeError(err) })
    }
  },
  upsert: (mode) =>
    set((s) => {
      const exists = s.modes.some((m) => m.id === mode.id)
      const modes = exists ? s.modes.map((m) => (m.id === mode.id ? mode : m)) : [...s.modes, mode]
      return { modes: sortModes(modes) }
    }),
  remove: (id) => set((s) => ({ modes: s.modes.filter((m) => m.id !== id) })),
  setActive: async (id) => {
    watchSettingsForChoice()
    const base = useSettings.getState().settings.activeModeId
    if (id === base) {
      // Already active: nothing to bridge.
      set({ activeChoice: null })
    } else {
      set({ activeChoice: { id, base } })
    }
    const mine = get().activeChoice
    try {
      await invoke('modes:setActive', { id })
    } catch (err) {
      // Main refused: show the real setting again (unless a newer choice replaced this one).
      if (mine && get().activeChoice === mine) set({ activeChoice: null })
      throw err
    }
  },
}))

/** The active Mode id given the settings value and a pending choice (pure; unit-tested). */
export function resolveActiveModeId(activeModeId: string, choice: ActiveChoice | null): string {
  return choice && choice.base === activeModeId ? choice.id : activeModeId
}

/** The active Mode id, including a choice main has not echoed back through settings yet. */
export function useActiveModeId(): string {
  const activeModeId = useSettings((s) => s.settings.activeModeId)
  const choice = useModes((s) => s.activeChoice)
  return resolveActiveModeId(activeModeId, choice)
}

function sortModes(modes: Mode[]): Mode[] {
  return [...modes].sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name))
}
