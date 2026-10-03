import type { Settings } from '@shared/settings'
import type { Db } from '../db/database'
import type { Logger } from '../log'
import type { SettingsStore } from '../settings/settingsStore'
import {
  deleteSessionScreenshots,
  pruneUnattachedScreenshots,
  sweepOrphanScreenshots,
} from './screenshots'
import { yieldToEventLoop } from './yieldToEventLoop'

export type RetentionDays = Settings['privacy']['retentionDays']

const DAY_MS = 24 * 60 * 60 * 1000
export const RETENTION_INTERVAL_MS = 12 * 60 * 60 * 1000
/** The launch run waits this long so it never competes with opening the windows. */
export const RETENTION_STARTUP_DELAY_MS = 5_000
/** Rough cap on how long one delete transaction may hold the main process. */
export const RETENTION_BATCH_BUDGET_MS = 25

/** Frees pages left by deletes. Never a plain VACUUM: it could renumber the rowids the search index uses. */
export function reclaimSpace(db: Db): void {
  db.exec('PRAGMA incremental_vacuum')
}

export interface RetentionRunOptions {
  /** Saved screenshots of deleted meetings are removed from here, and old no-session ones. */
  screenshotsDir?: string | null
  log?: Logger
  /**
   * Each transaction deletes meetings until it has run this long (at least one meeting), then
   * the event loop gets a turn. better-sqlite3 is synchronous, so one big transaction would
   * freeze every window (and a live call) for seconds on a large history.
   */
  budgetMs?: number
  /** Awaited before every batch (default: {@link yieldToEventLoop}). */
  yieldFn?: () => Promise<void>
  /** Checked before every batch; a cancelled run stops between batches. */
  isCancelled?: () => boolean
  /** Called with the ids each committed batch deleted. */
  onBatch?: (ids: string[]) => void
  /** Monotonic clock for the batch budget (tests). */
  clock?: () => number
}

/**
 * Deletes meetings that started more than `retentionDays` before `nowMs` (0 = keep forever),
 * together with everything attached to them (their saved screenshots included), plus
 * session-less AI answers (search questions) and session-less screenshots of the same age.
 * The live session is never touched. Work is split into short transactions with the event loop
 * running in between. Returns the number of sessions deleted.
 */
export async function applyRetention(
  db: Db,
  retentionDays: RetentionDays,
  nowMs: number,
  opts: RetentionRunOptions = {},
): Promise<number> {
  if (!retentionDays || retentionDays <= 0) return 0
  const cutoff = nowMs - retentionDays * DAY_MS
  const budgetMs = opts.budgetMs ?? RETENTION_BATCH_BUDGET_MS
  const pause = opts.yieldFn ?? yieldToEventLoop
  const clock = opts.clock ?? (() => performance.now())

  // Never the session being recorded right now, even if the clock jumped.
  const ids = (
    db
      .prepare(
        "SELECT id FROM sessions WHERE started_at < ? AND status <> 'active' ORDER BY started_at",
      )
      .all(cutoff) as { id: string }[]
  ).map((r) => r.id)
  // Conditions are re-checked per row: the session list may change between batches.
  const deleteOne = db.prepare(
    "DELETE FROM sessions WHERE id = ? AND started_at < ? AND status <> 'active'",
  )

  let deleted = 0
  let next = 0
  while (next < ids.length) {
    await pause()
    if (opts.isCancelled?.()) return deleted
    const batch: string[] = []
    const started = clock()
    db.transaction(() => {
      do {
        const id = ids[next++] as string
        if (deleteOne.run(id, cutoff).changes > 0) batch.push(id)
      } while (next < ids.length && clock() - started < budgetMs)
    })()
    deleted += batch.length
    if (opts.screenshotsDir) deleteSessionScreenshots(opts.screenshotsDir, batch, opts.log)
    if (batch.length) opts.onBatch?.(batch)
  }

  const orphans = db
    .prepare('DELETE FROM ai_messages WHERE session_id IS NULL AND created_at < ?')
    .run(cutoff).changes
  if (deleted + orphans > 0) reclaimSpace(db)
  if (opts.screenshotsDir) pruneUnattachedScreenshots(opts.screenshotsDir, cutoff, opts.log)
  return deleted
}

export interface RetentionSchedulerOptions {
  db: Db
  settings: SettingsStore
  log: Logger
  /** Root of saved screenshots (AppPaths.screenshotsDir); null skips screenshot clean-up. */
  screenshotsDir?: string | null
  /** Called after a run that deleted at least one session (e.g. to refresh the history list). */
  onDeleted?: (count: number) => void
  intervalMs?: number
  startupDelayMs?: number
  now?: () => number
  /** Batch tuning passed to {@link applyRetention}. */
  batch?: Pick<RetentionRunOptions, 'budgetMs' | 'yieldFn' | 'clock'>
  timers?: {
    setTimeout: (fn: () => void, ms: number) => unknown
    clearTimeout: (handle: unknown) => void
    setInterval: (fn: () => void, ms: number) => unknown
    clearInterval: (handle: unknown) => void
  }
}

// A pending retention run must never keep the process alive on quit.
const unrefTimers: NonNullable<RetentionSchedulerOptions['timers']> = {
  setTimeout: (fn, ms) => {
    const h = setTimeout(fn, ms)
    h.unref?.()
    return h
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => {
    const h = setInterval(fn, ms)
    h.unref?.()
    return h
  },
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
}

/**
 * Applies the retention setting shortly after launch, every 12 hours, and right after the user
 * changes Settings › Privacy › Data retention. Runs never overlap: a request made while one is
 * in progress is coalesced into a single follow-up run. Each run also removes screenshot
 * folders whose meeting no longer exists.
 */
export class RetentionScheduler {
  private readonly timers: NonNullable<RetentionSchedulerOptions['timers']>
  private readonly startupHandle: unknown
  private readonly intervalHandle: unknown
  private readonly unsubscribe: () => void
  private readonly sessionExists: (id: string) => boolean
  private disposed = false
  /** Settles after the latest started or queued run. */
  private tail: Promise<unknown> = Promise.resolve()
  /** A queued run that has not started yet; further requests join it. */
  private queued: Promise<number> | null = null

  constructor(private readonly opts: RetentionSchedulerOptions) {
    this.timers = opts.timers ?? unrefTimers
    const exists = opts.db.prepare('SELECT 1 FROM sessions WHERE id = ?')
    this.sessionExists = (id) => exists.get(id) !== undefined
    this.unsubscribe = opts.settings.onChange((next, prev) => {
      if (next.privacy.retentionDays !== prev.privacy.retentionDays) void this.runNow()
    })
    this.intervalHandle = this.timers.setInterval(
      () => void this.runNow(),
      opts.intervalMs ?? RETENTION_INTERVAL_MS,
    )
    this.startupHandle = this.timers.setTimeout(
      () => void this.runNow(),
      opts.startupDelayMs ?? RETENTION_STARTUP_DELAY_MS,
    )
  }

  /**
   * Runs retention as soon as any run in progress has finished; never rejects. Resolves with
   * the number of sessions that run deleted.
   */
  runNow(): Promise<number> {
    if (this.disposed) return Promise.resolve(0)
    if (this.queued) return this.queued
    const run: Promise<number> = this.tail
      .then(() => {
        this.queued = null
        return this.runOnce()
      })
      // runOnce handles its own errors. This is the backstop: a rejected link would otherwise
      // stay in `tail` and `queued` forever, so every later run would return the same rejection
      // and retention would stop until the next launch.
      .catch((err: unknown) => {
        if (this.queued === run) this.queued = null
        this.opts.log.error('Retention run failed', err)
        return 0
      })
    this.queued = run
    this.tail = run
    return run
  }

  private async runOnce(): Promise<number> {
    if (this.disposed) return 0
    const { db, log, screenshotsDir } = this.opts
    let days: RetentionDays = 0
    let deleted = 0
    try {
      days = this.opts.settings.get().privacy.retentionDays
      await applyRetention(db, days, (this.opts.now ?? Date.now)(), {
        ...this.opts.batch,
        screenshotsDir,
        log,
        isCancelled: () => this.disposed,
        // Counted per batch so a run that fails half-way still refreshes the history list.
        onBatch: (ids) => {
          deleted += ids.length
        },
      })
      if (screenshotsDir && !this.disposed) {
        sweepOrphanScreenshots(screenshotsDir, this.sessionExists, log)
      }
    } catch (err) {
      log.error('Retention run failed', err)
    }
    if (deleted > 0) {
      log.info(`Retention: deleted ${deleted} session(s) older than ${days} days`)
      try {
        this.opts.onDeleted?.(deleted)
      } catch (err) {
        log.error('Retention: refreshing after the purge failed', err)
      }
    }
    return deleted
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.timers.clearTimeout(this.startupHandle)
    this.timers.clearInterval(this.intervalHandle)
    this.unsubscribe()
  }
}
