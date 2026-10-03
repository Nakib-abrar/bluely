import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyRetention,
  RETENTION_INTERVAL_MS,
  RETENTION_STARTUP_DELAY_MS,
  RetentionScheduler,
  type RetentionSchedulerOptions,
} from '@main/data/retention'
import {
  deleteSessionScreenshots,
  pruneUnattachedScreenshots,
  sweepOrphanScreenshots,
} from '@main/data/screenshots'
import { createLogger } from '@main/log'
import { SettingsStore } from '@main/settings/settingsStore'
import { count, DAY, makeRepos, seedSession } from './fixtures'

const NOW = 1000 * DAY

describe('applyRetention', () => {
  it('keeps everything when retention is "forever" (0)', async () => {
    const r = makeRepos()
    seedSession(r, { id: 'ancient', startedAt: 1 })
    seedSession(r, { id: 'recent', startedAt: NOW - DAY })
    expect(await applyRetention(r.db, 0, NOW)).toBe(0)
    expect(r.sessions.list()).toHaveLength(2)
  })

  it('deletes sessions that started before now − N days (boundary kept)', async () => {
    const r = makeRepos()
    const cutoff = NOW - 30 * DAY
    seedSession(r, {
      id: 'just-over',
      startedAt: cutoff - 1,
      lines: [['them', 'old secret plan']],
      actionItems: [{ text: 'old task' }],
      notesMarkdown: 'old notes',
    })
    seedSession(r, { id: 'exactly', startedAt: cutoff })
    seedSession(r, { id: 'inside', startedAt: NOW - 29 * DAY })
    seedSession(r, { id: 'live', startedAt: cutoff - 5 * DAY, status: 'active' })
    r.ai.insert({
      id: 'q-old',
      sessionId: null,
      kind: 'search_ask',
      label: 'q',
      promptText: null,
      createdAt: cutoff - 1,
      usedScreen: false,
    })
    r.ai.insert({
      id: 'q-new',
      sessionId: null,
      kind: 'search_ask',
      label: 'q',
      promptText: null,
      createdAt: cutoff + 1,
      usedScreen: false,
    })

    expect(await applyRetention(r.db, 30, NOW)).toBe(1)
    expect(
      r.sessions
        .list()
        .map((s) => s.id)
        .sort(),
    ).toEqual(['exactly', 'inside', 'live'])
    expect(
      count(r.db, "SELECT count(*) c FROM transcript_lines WHERE session_id = 'just-over'"),
    ).toBe(0)
    expect(count(r.db, "SELECT count(*) c FROM search_fts WHERE search_fts MATCH 'old'")).toBe(0)
    expect(r.ai.get('q-old')).toBeNull()
    expect(r.ai.get('q-new')).not.toBeNull()
  })

  it.each([
    [90, 2],
    [365, 1],
  ] as const)('applies %i-day retention', async (days, expected) => {
    const r = makeRepos()
    seedSession(r, { id: 'a', startedAt: NOW - 400 * DAY })
    seedSession(r, { id: 'b', startedAt: NOW - 100 * DAY })
    seedSession(r, { id: 'c', startedAt: NOW - 10 * DAY })
    expect(await applyRetention(r.db, days, NOW)).toBe(expected)
  })

  it('reclaims space with incremental vacuum on a file database', async () => {
    const { mkdtempSync, rmSync, statSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { default: Database } = await import('better-sqlite3')
    const { runMigrations } = await import('@main/db/migrations')
    const dir = mkdtempSync(join(tmpdir(), 'bluely-retention-'))
    try {
      // Same setup as openDatabase(), but auto_vacuum is set before WAL creates page 1;
      // otherwise SQLite silently keeps auto_vacuum = NONE for new files (reported upstream).
      const db = new Database(join(dir, 'b.db'))
      db.pragma('auto_vacuum = INCREMENTAL')
      db.pragma('journal_mode = WAL')
      db.pragma('foreign_keys = ON')
      runMigrations(db)
      expect(db.pragma('auto_vacuum', { simple: true })).toBe(2)
      const r = makeRepos(db)
      for (let s = 0; s < 20; s++) {
        seedSession(r, {
          id: `s${s}`,
          startedAt: NOW - 400 * DAY,
          lines: Array.from({ length: 50 }, (_, i): ['me', string] => [
            'me',
            `line ${i} ${'x'.repeat(200)}`,
          ]),
        })
      }
      db.pragma('wal_checkpoint(TRUNCATE)')
      const before = db.pragma('page_count', { simple: true }) as number
      expect(await applyRetention(db, 30, NOW)).toBe(20)
      db.pragma('wal_checkpoint(TRUNCATE)')
      const after = db.pragma('page_count', { simple: true }) as number
      expect(after).toBeLessThan(before)
      expect(db.pragma('freelist_count', { simple: true })).toBe(0)
      db.close()
      expect(statSync(join(dir, 'b.db')).size).toBeGreaterThan(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

const tempDirs: string[] = []
afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A screenshots dir with `<id>/<card>.jpg` for each id (and `no-session/` files). */
function shotsDir(ids: string[], noSession: { name: string; mtimeMs: number }[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), 'bluely-shots-'))
  tempDirs.push(dir)
  for (const id of ids) {
    mkdirSync(join(dir, id), { recursive: true })
    writeFileSync(join(dir, id, 'card.jpg'), 'jpeg')
  }
  if (noSession.length) mkdirSync(join(dir, 'no-session'), { recursive: true })
  for (const f of noSession) {
    const file = join(dir, 'no-session', f.name)
    writeFileSync(file, 'jpeg')
    utimesSync(file, f.mtimeMs / 1000, f.mtimeMs / 1000)
  }
  return dir
}

describe('applyRetention and saved screenshots', () => {
  it('deletes the screenshot folders of purged meetings and old no-session shots', async () => {
    const r = makeRepos()
    const cutoff = NOW - 30 * DAY
    seedSession(r, { id: 'old', startedAt: cutoff - DAY })
    seedSession(r, { id: 'keep', startedAt: NOW - DAY })
    seedSession(r, { id: 'live', startedAt: cutoff - DAY, status: 'active' })
    const dir = shotsDir(
      ['old', 'keep', 'live'],
      [
        { name: 'stale.jpg', mtimeMs: cutoff - 1000 },
        { name: 'fresh.jpg', mtimeMs: cutoff + 60_000 },
      ],
    )
    expect(await applyRetention(r.db, 30, NOW, { screenshotsDir: dir })).toBe(1)
    expect(existsSync(join(dir, 'old'))).toBe(false)
    expect(existsSync(join(dir, 'keep', 'card.jpg'))).toBe(true)
    expect(existsSync(join(dir, 'live', 'card.jpg'))).toBe(true)
    expect(readdirSync(join(dir, 'no-session'))).toEqual(['fresh.jpg'])
  })

  it('works when no screenshot was ever saved', async () => {
    const r = makeRepos()
    seedSession(r, { id: 'old', startedAt: 1 })
    const dir = join(mkdtempSync(join(tmpdir(), 'bluely-shots-')), 'missing')
    tempDirs.push(dir)
    expect(await applyRetention(r.db, 30, NOW, { screenshotsDir: dir })).toBe(1)
  })

  it('deletes in short transactions with the event loop running in between', async () => {
    const r = makeRepos()
    for (let i = 0; i < 5; i++) seedSession(r, { id: `s${i}`, startedAt: i + 1 })
    seedSession(r, { id: 'keep', startedAt: NOW })
    const batches: string[][] = []
    let yields = 0
    const deleted = await applyRetention(r.db, 30, NOW, {
      budgetMs: 0, // one meeting per transaction
      yieldFn: async () => {
        yields++
      },
      onBatch: (ids) => batches.push(ids),
    })
    expect(deleted).toBe(5)
    expect(batches).toEqual([['s0'], ['s1'], ['s2'], ['s3'], ['s4']])
    expect(yields).toBe(5)
    expect(r.sessions.list().map((s) => s.id)).toEqual(['keep'])
  })

  it('stops between batches when cancelled, and skips meetings that became live', async () => {
    const r = makeRepos()
    for (let i = 0; i < 4; i++) seedSession(r, { id: `s${i}`, startedAt: i + 1 })
    let batches = 0
    const deleted = await applyRetention(r.db, 30, NOW, {
      budgetMs: 0,
      yieldFn: async () => {
        // A meeting resumed between batches must not be deleted.
        if (batches === 1) r.sessions.setStatus('s1', 'active')
      },
      onBatch: () => batches++,
      isCancelled: () => batches >= 2,
    })
    expect(deleted).toBe(2) // s0 and s2; s1 went live, the run was cancelled before s3
    expect(r.sessions.get('s1')).not.toBeNull()
    expect(r.sessions.get('s3')).not.toBeNull()
  })
})

describe('screenshot helpers', () => {
  it('never turns an id that is not a plain session id into a path', () => {
    const dir = shotsDir(['abc', 'no-session'])
    const outside = mkdtempSync(join(tmpdir(), 'bluely-outside-'))
    tempDirs.push(outside)
    writeFileSync(join(outside, 'keep.txt'), 'x')
    const n = deleteSessionScreenshots(dir, ['..', '../x', outside, 'no-session', '', 'abc'])
    expect(n).toBe(1)
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true)
    expect(existsSync(join(dir, 'no-session', 'card.jpg'))).toBe(true)
    expect(existsSync(join(dir, 'abc'))).toBe(false)
  })

  it('sweeps folders of meetings that no longer exist', () => {
    const dir = shotsDir(['gone', 'here', 'no-session'])
    expect(sweepOrphanScreenshots(dir, (id) => id === 'here')).toBe(1)
    expect(readdirSync(dir).sort()).toEqual(['here', 'no-session'])
  })

  it('prunes only no-session files older than the cutoff', () => {
    const dir = shotsDir(
      [],
      [
        { name: 'a.jpg', mtimeMs: 1_000_000 },
        { name: 'b.jpg', mtimeMs: 3_000_000 },
      ],
    )
    expect(pruneUnattachedScreenshots(dir, 2_000_000)).toBe(1)
    expect(readdirSync(join(dir, 'no-session'))).toEqual(['b.jpg'])
  })
})

describe('RetentionScheduler', () => {
  function setup(
    retentionDays: 0 | 30 | 90 | 365,
    screenshotsDir: string | null = null,
    batch?: RetentionSchedulerOptions['batch'],
  ) {
    const r = makeRepos()
    const settings = new SettingsStore(r.db)
    settings.update({ privacy: { retentionDays } })
    seedSession(r, { id: 'old', startedAt: NOW - 100 * DAY })
    seedSession(r, { id: 'mid', startedAt: NOW - 50 * DAY })
    seedSession(r, { id: 'new', startedAt: NOW - DAY })
    let tick: (() => void) | null = null
    let startup: (() => void) | null = null
    const timers = {
      setTimeout: vi.fn((fn: () => void, _ms: number) => {
        startup = fn
        return 7
      }),
      clearTimeout: vi.fn(),
      setInterval: vi.fn((fn: () => void, _ms: number) => {
        tick = fn
        return 42
      }),
      clearInterval: vi.fn(),
    }
    const onDeleted = vi.fn()
    let now = NOW
    const scheduler = new RetentionScheduler({
      db: r.db,
      settings,
      log: createLogger(null),
      onDeleted,
      timers,
      screenshotsDir,
      batch,
      now: () => now,
    })
    return {
      r,
      settings,
      scheduler,
      timers,
      onDeleted,
      startup: () => startup?.(),
      tick: () => tick?.(),
      advance: (ms: number) => {
        now += ms
      },
    }
  }

  it('runs shortly after start (not in the constructor) and every 12 hours', async () => {
    const t = setup(90)
    expect(t.r.sessions.list()).toHaveLength(3)
    expect(t.timers.setTimeout).toHaveBeenCalledWith(
      expect.any(Function),
      RETENTION_STARTUP_DELAY_MS,
    )
    t.startup()
    await t.scheduler.runNow()
    expect(t.r.sessions.list().map((s) => s.id)).toEqual(['new', 'mid'])
    expect(t.onDeleted).toHaveBeenCalledWith(1)
    expect(t.timers.setInterval).toHaveBeenCalledWith(expect.any(Function), RETENTION_INTERVAL_MS)
    t.advance(45 * DAY)
    t.tick()
    await t.scheduler.runNow()
    expect(t.r.sessions.list().map((s) => s.id)).toEqual(['new'])
    expect(t.onDeleted).toHaveBeenCalledTimes(2)
    t.tick()
    await t.scheduler.runNow()
    expect(t.onDeleted).toHaveBeenCalledTimes(2) // nothing more to delete
    t.scheduler.dispose()
  })

  it('coalesces requests made while a run is in progress', async () => {
    const during: Promise<number>[] = []
    let scheduler: RetentionScheduler | null = null
    const t = setup(30, null, {
      budgetMs: 0,
      yieldFn: async () => {
        // Requests arriving mid-run all join one follow-up run.
        if (scheduler && during.length < 2) during.push(scheduler.runNow())
      },
    })
    scheduler = t.scheduler
    const a = t.scheduler.runNow()
    expect(t.scheduler.runNow()).toBe(a) // not started yet: joins it
    expect(await a).toBe(2)
    expect(during).toHaveLength(2) // one per batch
    expect(during[0]).not.toBe(a)
    expect(during[1]).toBe(during[0])
    expect(await during[0]).toBe(0)
    expect(t.onDeleted).toHaveBeenCalledTimes(1)
    t.scheduler.dispose()
  })

  it('runs when the retention setting changes, and not after dispose', async () => {
    const t = setup(0)
    await t.scheduler.runNow()
    expect(t.r.sessions.list()).toHaveLength(3)
    t.settings.update({ general: { theme: 'light' } })
    await t.scheduler.runNow()
    expect(t.r.sessions.list()).toHaveLength(3)
    t.settings.update({ privacy: { retentionDays: 30 } })
    await t.scheduler.runNow()
    expect(t.r.sessions.list().map((s) => s.id)).toEqual(['new'])
    t.scheduler.dispose()
    t.scheduler.dispose()
    expect(t.timers.clearInterval).toHaveBeenCalledTimes(1)
    expect(t.timers.clearInterval).toHaveBeenCalledWith(42)
    expect(t.timers.clearTimeout).toHaveBeenCalledWith(7)
    seedSession(t.r, { id: 'older', startedAt: 1 })
    t.settings.update({ privacy: { retentionDays: 365 } })
    expect(await t.scheduler.runNow()).toBe(0)
    expect(t.r.sessions.get('older')).not.toBeNull()
  })

  it('removes screenshots of purged meetings and orphaned screenshot folders', async () => {
    const dir = shotsDir(['old', 'mid', 'new', 'deleted-long-ago'])
    const t = setup(90, dir)
    expect(await t.scheduler.runNow()).toBe(1)
    expect(readdirSync(dir).sort()).toEqual(['mid', 'new'])
    t.scheduler.dispose()
  })

  it('never rejects when the database fails', async () => {
    const t = setup(30)
    const log = createLogger(null)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const broken = new RetentionScheduler({
      db: {
        prepare: () => {
          const fail = () => {
            throw new Error('disk I/O error')
          }
          return { all: fail, get: fail, run: fail }
        },
        transaction: () => () => {
          throw new Error('disk I/O error')
        },
      } as unknown as typeof t.r.db,
      settings: t.settings,
      log,
      timers: {
        setTimeout: () => 1,
        clearTimeout: () => undefined,
        setInterval: () => 1,
        clearInterval: () => undefined,
      },
    })
    expect(await broken.runNow()).toBe(0)
    expect(error).toHaveBeenCalled()
    broken.dispose()
    t.scheduler.dispose()
  })

  it('does not keep the process alive with real timers', async () => {
    const r = makeRepos()
    const settings = new SettingsStore(r.db)
    const scheduler = new RetentionScheduler({ db: r.db, settings, log: createLogger(null) })
    expect(await scheduler.runNow()).toBe(0)
    scheduler.dispose()
  })
})
