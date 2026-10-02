import { describe, expect, it } from 'vitest'
import { openDatabase } from '@main/db/database'
import { LATEST_SCHEMA_VERSION, rebuildSearchIndex } from '@main/db/migrations'

function seed(db: ReturnType<typeof openDatabase>) {
  const now = Date.now()
  db.prepare(
    "INSERT INTO sessions(id, title, mode_id, started_at, status, created_at) VALUES ('s1', 'Quarterly pricing review', 'builtin-general', ?, 'active', ?)",
  ).run(now, now)
  const ins = db.prepare(
    'INSERT INTO transcript_lines(id, session_id, channel, start_ms, end_ms, text, is_final) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
  ins.run('l1', 's1', 'them', 0, 1000, 'What does the enterprise plan cost per seat?', 1)
  ins.run('l2', 's1', 'me', 1200, 2000, 'It starts at forty dollars per seat.', 1)
  ins.run('l3', 's1', 'them', 2100, 2500, 'partial words', 0)
}

describe('database foundation', () => {
  it('migrates to the latest schema with WAL and incremental auto-vacuum', () => {
    const db = openDatabase(':memory:')
    expect(db.pragma('user_version', { simple: true })).toBe(LATEST_SCHEMA_VERSION)
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(db.pragma('auto_vacuum', { simple: true })).toBe(2)
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table') ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name)
    for (const t of [
      'sessions',
      'transcript_lines',
      'ai_messages',
      'action_items',
      'modes',
      'knowledge_files',
      'knowledge_chunks',
      'settings',
      'model_stats',
      'usage_log',
      'search_fts',
      'search_trigram',
      'knowledge_chunks_fts',
    ]) {
      expect(tables).toContain(t)
    }
  })

  it('indexes final transcript lines and titles, and follows updates and deletes', () => {
    const db = openDatabase(':memory:')
    seed(db)
    const q = (m: string) =>
      db
        .prepare('SELECT kind, ref_id FROM search_fts WHERE search_fts MATCH ? ORDER BY rank')
        .all(m) as {
        kind: string
        ref_id: string
      }[]
    expect(q('enterprise').map((r) => r.ref_id)).toEqual(['l1'])
    expect(q('pric*').map((r) => r.kind)).toEqual(['title'])
    expect(q('partial')).toEqual([]) // non-final lines are not indexed
    db.prepare("UPDATE transcript_lines SET is_final = 1 WHERE id = 'l3'").run()
    expect(q('partial').map((r) => r.ref_id)).toEqual(['l3'])
    db.prepare("UPDATE sessions SET title = 'Renamed sync' WHERE id = 's1'").run()
    expect(q('pric*')).toEqual([])
    expect(q('renamed').map((r) => r.kind)).toEqual(['title'])
    // Trigram index tolerates substrings.
    const tri = db
      .prepare("SELECT ref_id FROM search_trigram WHERE search_trigram MATCH 'erpris'")
      .all()
    expect(tri).toHaveLength(1)
    db.prepare("DELETE FROM sessions WHERE id = 's1'").run()
    expect(db.prepare('SELECT count(*) c FROM search_fts').get()).toEqual({ c: 0 })
    expect(db.prepare('SELECT count(*) c FROM search_trigram').get()).toEqual({ c: 0 })
    expect(db.prepare('SELECT count(*) c FROM transcript_lines').get()).toEqual({ c: 0 })
  })

  it('rebuilds the search index from source tables', () => {
    const db = openDatabase(':memory:')
    seed(db)
    db.exec('DELETE FROM search_fts; DELETE FROM search_trigram;')
    rebuildSearchIndex(db)
    expect(
      db.prepare("SELECT count(*) c FROM search_fts WHERE search_fts MATCH 'seat'").get(),
    ).toEqual({ c: 2 })
  })

  it('keeps knowledge chunk FTS in sync', () => {
    const db = openDatabase(':memory:')
    const now = Date.now()
    db.prepare(
      "INSERT INTO modes(id, name, created_at, updated_at) VALUES ('m1', 'Sales', ?, ?)",
    ).run(now, now)
    db.prepare(
      "INSERT INTO knowledge_files(id, mode_id, filename, size, added_at) VALUES ('f1', 'm1', 'pricing.md', 10, ?)",
    ).run(now)
    db.prepare(
      "INSERT INTO knowledge_chunks(file_id, idx, text) VALUES ('f1', 0, 'Enterprise plan includes SSO and audit logs')",
    ).run()
    const hit = () =>
      db
        .prepare("SELECT rowid FROM knowledge_chunks_fts WHERE knowledge_chunks_fts MATCH 'audit'")
        .all()
    expect(hit()).toHaveLength(1)
    db.prepare("DELETE FROM knowledge_files WHERE id = 'f1'").run()
    expect(hit()).toHaveLength(0)
  })
})

describe('FTS tokenizer (migration 2)', () => {
  it('keeps Bangla words whole and still folds Latin diacritics', () => {
    const db = openDatabase(':memory:')
    const now = Date.now()
    db.prepare(
      "INSERT INTO sessions(id, title, started_at, status, created_at) VALUES ('s1', 'Budget call', ?, 'done', ?)",
    ).run(now, now)
    db.prepare(
      "INSERT INTO transcript_lines(id, session_id, channel, start_ms, end_ms, text, is_final) VALUES ('l1', 's1', 'them', 0, 1, 'আমাদের বাজেট কত? Café résumé', 1)",
    ).run()
    const count = (m: string) =>
      (
        db.prepare('SELECT count(*) c FROM search_fts WHERE search_fts MATCH ?').get(m) as {
          c: number
        }
      ).c
    expect(count('"আমাদের"')).toBe(1)
    expect(count('"আমা"*')).toBe(1)
    // A vowel-sign fragment must not match on its own any more.
    expect(count('"দ"')).toBe(0)
    expect(count('cafe')).toBe(1)
    expect(count('resume')).toBe(1)
  })
})
