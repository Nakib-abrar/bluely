import { describe, expect, it, vi } from 'vitest'
import { applyRetention, RETENTION_INTERVAL_MS, RetentionScheduler } from '@main/data/retention'
import { createLogger } from '@main/log'
import { SettingsStore } from '@main/settings/settingsStore'
import { count, DAY, makeRepos, seedSession } from './fixtures'

const NOW = 1000 * DAY

describe('applyRetention', () => {
  it('keeps everything when retention is "forever" (0)', () => {
    const r = makeRepos()
    seedSession(r, { id: 'ancient', startedAt: 1 })
    seedSession(r, { id: 'recent', startedAt: NOW - DAY })
    expect(applyRetention(r.db, 0, NOW)).toBe(0)
    expect(r.sessions.list()).toHaveLength(2)
  })

  it('deletes sessions that started before now − N days (boundary kept)', () => {
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

    expect(applyRetention(r.db, 30, NOW)).toBe(1)
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
  ] as const)('applies %i-day retention', (days, expected) => {
    const r = makeRepos()
    seedSession(r, { id: 'a', startedAt: NOW - 400 * DAY })
    seedSession(r, { id: 'b', startedAt: NOW - 100 * DAY })
    seedSession(r, { id: 'c', startedAt: NOW - 10 * DAY })
    expect(applyRetention(r.db, days, NOW)).toBe(expected)
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
      expect(applyRetention(db, 30, NOW)).toBe(20)
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

describe('RetentionScheduler', () => {
  function setup(retentionDays: 0 | 30 | 90 | 365) {
    const r = makeRepos()
    const settings = new SettingsStore(r.db)
    settings.update({ privacy: { retentionDays } })
    seedSession(r, { id: 'old', startedAt: NOW - 100 * DAY })
    seedSession(r, { id: 'mid', startedAt: NOW - 50 * DAY })
    seedSession(r, { id: 'new', startedAt: NOW - DAY })
    let tick: (() => void) | null = null
    const timers = {
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
      now: () => now,
    })
    return {
      r,
      settings,
      scheduler,
      timers,
      onDeleted,
      tick: () => tick?.(),
      advance: (ms: number) => {
        now += ms
      },
    }
  }

  it('runs at start and every 12 hours', () => {
    const t = setup(90)
    expect(t.r.sessions.list().map((s) => s.id)).toEqual(['new', 'mid'])
    expect(t.onDeleted).toHaveBeenCalledWith(1)
    expect(t.timers.setInterval).toHaveBeenCalledWith(expect.any(Function), RETENTION_INTERVAL_MS)
    t.advance(45 * DAY)
    t.tick()
    expect(t.r.sessions.list().map((s) => s.id)).toEqual(['new'])
    expect(t.onDeleted).toHaveBeenCalledTimes(2)
    t.tick()
    expect(t.onDeleted).toHaveBeenCalledTimes(2) // nothing more to delete
    t.scheduler.dispose()
  })

  it('runs when the retention setting changes, and not after dispose', () => {
    const t = setup(0)
    expect(t.r.sessions.list()).toHaveLength(3)
    t.settings.update({ general: { theme: 'light' } })
    expect(t.r.sessions.list()).toHaveLength(3)
    t.settings.update({ privacy: { retentionDays: 30 } })
    expect(t.r.sessions.list().map((s) => s.id)).toEqual(['new'])
    t.scheduler.dispose()
    t.scheduler.dispose()
    expect(t.timers.clearInterval).toHaveBeenCalledTimes(1)
    expect(t.timers.clearInterval).toHaveBeenCalledWith(42)
    seedSession(t.r, { id: 'older', startedAt: 1 })
    t.settings.update({ privacy: { retentionDays: 365 } })
    expect(t.scheduler.runNow()).toBe(0)
    expect(t.r.sessions.get('older')).not.toBeNull()
  })

  it('never throws when the database fails', () => {
    const t = setup(30)
    const log = createLogger(null)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const broken = new RetentionScheduler({
      db: {
        transaction: () => () => {
          throw new Error('disk I/O error')
        },
      } as unknown as typeof t.r.db,
      settings: t.settings,
      log,
      timers: { setInterval: () => 1, clearInterval: () => undefined },
    })
    expect(broken.runNow()).toBe(0)
    expect(error).toHaveBeenCalled()
    broken.dispose()
    t.scheduler.dispose()
  })

  it('does not keep the process alive with real timers', () => {
    const r = makeRepos()
    const settings = new SettingsStore(r.db)
    const scheduler = new RetentionScheduler({ db: r.db, settings, log: createLogger(null) })
    expect(scheduler.runNow()).toBe(0)
    scheduler.dispose()
  })
})
