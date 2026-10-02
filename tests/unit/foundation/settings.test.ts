import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS,
  mergeSettings,
  normalizeSettings,
  settingsSchema,
} from '@shared/settings'
import { openDatabase } from '@main/db/database'
import { SettingsStore } from '@main/settings/settingsStore'

describe('settings', () => {
  it('defaults are valid', () => {
    expect(settingsSchema.safeParse(DEFAULT_SETTINGS).success).toBe(true)
    expect(DEFAULT_SETTINGS.general.consentReminder).toBe(true)
    expect(DEFAULT_SETTINGS.general.autoSuggest).toBe(true)
    expect(DEFAULT_SETTINGS.privacy.saveScreenshots).toBe(false)
    expect(DEFAULT_SETTINGS.keybinds.toggleOverlay).toBe('CommandOrControl+\\')
  })

  it('merges deep partial patches and ignores unknown keys', () => {
    const merged = mergeSettings(DEFAULT_SETTINGS, {
      general: { theme: 'light' },
      bogus: 1,
      overlay: { positions: { '1': { x: 1, y: 2 } } },
    })
    expect(merged.general.theme).toBe('light')
    expect(merged.general.consentReminder).toBe(true)
    expect(merged.overlay.positions['1']).toEqual({ x: 1, y: 2 })
    expect('bogus' in merged).toBe(false)
  })

  it('repairs invalid stored sections without losing valid ones', () => {
    const s = normalizeSettings({
      general: { theme: 'neon' },
      profile: { name: 'Ada', role: '', company: '', about: '' },
    })
    expect(s.general.theme).toBe('dark')
    expect(s.profile.name).toBe('Ada')
  })

  it('persists updates and rejects invalid ones', () => {
    const db = openDatabase(':memory:')
    const store = new SettingsStore(db)
    store.update({ advanced: { contextMinutes: 8 } })
    expect(new SettingsStore(db).get().advanced.contextMinutes).toBe(8)
    expect(() => store.update({ advanced: { contextMinutes: 999 } })).toThrow(/contextMinutes/)
    const reset = store.reset('advanced')
    expect(reset.advanced.contextMinutes).toBe(DEFAULT_SETTINGS.advanced.contextMinutes)
  })
})
