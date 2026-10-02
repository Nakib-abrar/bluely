import type { Settings } from '@shared/settings'
import type { Db } from '../db/database'
import type { Logger } from '../log'
import type { SettingsStore } from '../settings/settingsStore'

export type RetentionDays = Settings['privacy']['retentionDays']

const DAY_MS = 24 * 60 * 60 * 1000
export const RETENTION_INTERVAL_MS = 12 * 60 * 60 * 1000

/** Frees pages left by deletes. Never a plain VACUUM: it could renumber the rowids the search index uses. */
export function reclaimSpace(db: Db): void {
  db.exec('PRAGMA incremental_vacuum')
}

/**
 * Deletes meetings that started more than `retentionDays` before `nowMs` (0 = keep forever),
 * together with everything attached to them, plus session-less AI answers (search questions)
 * of the same age. The live session is never touched. Returns the number of sessions deleted.
 */
export function applyRetention(db: Db, retentionDays: RetentionDays, nowMs: number): number {
  if (!retentionDays || retentionDays <= 0) return 0
  const cutoff = nowMs - retentionDays * DAY_MS
  const tx = db.transaction(() => {
    const sessions = db
      .prepare("DELETE FROM sessions WHERE started_at < ? AND status <> 'active'")
      .run(cutoff).changes
    const orphans = db
      .prepare('DELETE FROM ai_messages WHERE session_id IS NULL AND created_at < ?')
      .run(cutoff).changes
    return { sessions, orphans }
  })
  const { sessions, orphans } = tx()
  if (sessions + orphans > 0) reclaimSpace(db)
  return sessions
}

export interface RetentionSchedulerOptions {
  db: Db
  settings: SettingsStore
  log: Logger
  /** Called after a run that deleted at least one session (e.g. to refresh the history list). */
  onDeleted?: (count: number) => void
  intervalMs?: number
  now?: () => number
  timers?: {
    setInterval: (fn: () => void, ms: number) => unknown
    clearInterval: (handle: unknown) => void
  }
}

/**
 * Applies the retention setting at startup, every 12 hours, and right after the user changes
 * Settings › Privacy › Data retention.
 */
export class RetentionScheduler {
  private readonly timers: NonNullable<RetentionSchedulerOptions['timers']>
  private readonly handle: unknown
  private readonly unsubscribe: () => void
  private disposed = false

  constructor(private readonly opts: RetentionSchedulerOptions) {
    this.timers = opts.timers ?? {
      setInterval: (fn: () => void, ms: number) => {
        const h = setInterval(fn, ms)
        // A pending retention run must never keep the process alive on quit.
        h.unref?.()
        return h
      },
      clearInterval: (h: unknown) => clearInterval(h as ReturnType<typeof setInterval>),
    }
    this.unsubscribe = opts.settings.onChange((next, prev) => {
      if (next.privacy.retentionDays !== prev.privacy.retentionDays) this.runNow()
    })
    this.handle = this.timers.setInterval(
      () => this.runNow(),
      opts.intervalMs ?? RETENTION_INTERVAL_MS,
    )
    this.runNow()
  }

  /** Runs retention now; never throws. Returns the number of sessions deleted. */
  runNow(): number {
    if (this.disposed) return 0
    const days = this.opts.settings.get().privacy.retentionDays
    try {
      const deleted = applyRetention(this.opts.db, days, (this.opts.now ?? Date.now)())
      if (deleted > 0) {
        this.opts.log.info(`Retention: deleted ${deleted} session(s) older than ${days} days`)
        this.opts.onDeleted?.(deleted)
      }
      return deleted
    } catch (err) {
      this.opts.log.error('Retention run failed', err)
      return 0
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.timers.clearInterval(this.handle)
    this.unsubscribe()
  }
}
