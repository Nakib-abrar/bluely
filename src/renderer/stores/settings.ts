import { create } from 'zustand'
import { DEFAULT_SETTINGS, type DeepPartial, type Settings } from '@shared/settings'
import { invoke, on } from '../lib/ipc'
import { applyTheme } from '../lib/theme'

interface SettingsState {
  settings: Settings
  loaded: boolean
  load: () => Promise<void>
  update: (patch: DeepPartial<Settings>) => Promise<Settings>
}

/** Mirror of the main-process settings, kept in sync via the settings:changed event. */
export const useSettings = create<SettingsState>((set) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  load: async () => {
    const s = await invoke('settings:get')
    applyTheme(s.general.theme)
    set({ settings: s, loaded: true })
  },
  update: async (patch) => {
    const s = await invoke('settings:update', { patch: patch as Record<string, unknown> })
    applyTheme(s.general.theme)
    set({ settings: s })
    return s
  },
}))

let subscribed = false
/** Call once per window at startup. */
export function initSettingsSync(): Promise<void> {
  if (!subscribed) {
    subscribed = true
    on('settings:changed', (s) => {
      applyTheme(s.general.theme)
      useSettings.setState({ settings: s, loaded: true })
    })
  }
  return useSettings.getState().load()
}
