import {
  DEFAULT_SETTINGS,
  mergeSettings,
  normalizeSettings,
  settingsSchema,
  type Settings,
} from '@shared/settings'
import { AppError } from '../errors'
import type { Db } from '../db/database'

type Listener = (next: Settings, prev: Settings) => void

/**
 * Settings live in the `settings` table, one row per top-level section.
 * Reads are served from memory; writes validate the merged result before persisting.
 */
export class SettingsStore {
  private current: Settings
  private listeners = new Set<Listener>()

  constructor(private readonly db: Db) {
    this.current = this.load()
  }

  get(): Settings {
    return this.current
  }

  update(patch: unknown): Settings {
    const merged = mergeSettings(this.current, patch)
    const parsed = settingsSchema.safeParse(merged)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      throw new AppError(
        'invalid_settings',
        `Invalid setting ${issue?.path.join('.') ?? ''}: ${issue?.message ?? 'unknown'}`,
      )
    }
    return this.commit(parsed.data)
  }

  reset(section: 'keybinds' | 'advanced' | 'all'): Settings {
    if (section === 'all') {
      // Keep onboarding state and profile on a full reset of preferences.
      return this.commit({
        ...DEFAULT_SETTINGS,
        general: {
          ...DEFAULT_SETTINGS.general,
          onboardingComplete: this.current.general.onboardingComplete,
        },
        profile: this.current.profile,
      })
    }
    return this.commit({ ...this.current, [section]: structuredClone(DEFAULT_SETTINGS[section]) })
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private commit(next: Settings): Settings {
    const prev = this.current
    const upsert = this.db.prepare(
      'INSERT INTO settings(key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json',
    )
    const tx = this.db.transaction(() => {
      for (const key of Object.keys(next) as (keyof Settings)[]) {
        if (JSON.stringify(next[key]) !== JSON.stringify(prev[key])) {
          upsert.run(key, JSON.stringify(next[key]))
        }
      }
    })
    tx()
    this.current = next
    for (const fn of this.listeners) {
      try {
        fn(next, prev)
      } catch {
        /* listeners must not break persistence */
      }
    }
    return next
  }

  private load(): Settings {
    const rows = this.db.prepare('SELECT key, value_json FROM settings').all() as {
      key: string
      value_json: string
    }[]
    const stored: Record<string, unknown> = {}
    for (const row of rows) {
      try {
        stored[row.key] = JSON.parse(row.value_json)
      } catch {
        /* ignore corrupt row; defaults apply */
      }
    }
    return normalizeSettings(stored)
  }
}
