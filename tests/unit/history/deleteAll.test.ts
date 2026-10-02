import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { deleteAllData } from '@main/data/deleteAll'
import { openDatabase } from '@main/db/database'
import { SettingsStore } from '@main/settings/settingsStore'
import { count, makeRepos, seedSession } from './fixtures'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'bluely-deleteall-'))
  dirs.push(d)
  return d
}

describe('deleteAllData', () => {
  it('removes all user data but keeps built-in modes, settings and the key file', () => {
    const dir = tempDir()
    const db = openDatabase(join(dir, 'bluely.db'))
    const r = makeRepos(db)
    const settings = new SettingsStore(db)
    settings.update({ profile: { name: 'Ada' }, privacy: { retentionDays: 90 } })
    const keyFile = join(dir, 'openrouter-key.bin')
    writeFileSync(keyFile, 'encrypted')
    const screenshotsDir = join(dir, 'screenshots')
    mkdirSync(join(screenshotsDir, 'session-1'), { recursive: true })
    writeFileSync(join(screenshotsDir, 'session-1', 'shot.jpg'), 'jpg')

    const now = Date.now()
    db.prepare(
      `INSERT INTO modes(id, name, is_builtin, created_at, updated_at) VALUES
        ('builtin-general', 'General meeting', 1, ?, ?), ('builtin-sales', 'Sales call', 1, ?, ?),
        ('custom-1', 'Mine', 0, ?, ?)`,
    ).run(now, now, now, now, now, now)
    db.prepare(
      "INSERT INTO knowledge_files(id, mode_id, filename, size, status, added_at) VALUES ('f1', 'builtin-sales', 'deck.pdf', 1, 'parsed', ?), ('f2', 'custom-1', 'x.md', 1, 'parsed', ?)",
    ).run(now, now)
    db.prepare(
      "INSERT INTO knowledge_chunks(file_id, idx, text) VALUES ('f1', 0, 'pricing tiers'), ('f2', 0, 'custom stuff')",
    ).run()
    db.prepare(
      "INSERT INTO usage_log(created_at, kind, model, cost_usd) VALUES (?, 'llm', 'm', 0.01)",
    ).run(now)
    db.prepare(
      "INSERT INTO model_stats(model, provider, samples, updated_at) VALUES ('m', 'p', 3, ?)",
    ).run(now)
    seedSession(r, {
      id: 's1',
      title: 'Confidential pricing',
      startedAt: now - 1000,
      lines: [['them', 'confidential numbers']],
      notesMarkdown: 'confidential notes',
      emailMarkdown: 'confidential email',
      actionItems: [{ text: 'confidential task' }],
    })
    r.ai.insert({
      id: 'q',
      sessionId: null,
      kind: 'search_ask',
      label: 'q',
      promptText: 'p',
      createdAt: now,
      usedScreen: false,
    })

    const result = deleteAllData(db, { screenshotsDir })
    expect(result).toEqual({ sessions: 1, customModes: 1, knowledgeFiles: 2 })

    for (const t of [
      'sessions',
      'transcript_lines',
      'ai_messages',
      'action_items',
      'usage_log',
      'model_stats',
      'knowledge_files',
      'knowledge_chunks',
      'search_fts',
      'search_trigram',
    ]) {
      expect(count(db, `SELECT count(*) c FROM ${t}`), t).toBe(0)
    }
    expect(
      count(
        db,
        "SELECT count(*) c FROM knowledge_chunks_fts WHERE knowledge_chunks_fts MATCH 'pricing'",
      ),
    ).toBe(0)
    expect(
      (db.prepare('SELECT id FROM modes ORDER BY id').all() as { id: string }[]).map((m) => m.id),
    ).toEqual(['builtin-general', 'builtin-sales'])
    expect(new SettingsStore(db).get().profile.name).toBe('Ada')
    expect(new SettingsStore(db).get().privacy.retentionDays).toBe(90)
    expect(existsSync(keyFile)).toBe(true)
    expect(existsSync(screenshotsDir)).toBe(false)
    expect(db.pragma('secure_delete', { simple: true })).toBe(0) // restored

    // The app keeps working afterwards.
    r.sessions.create({ id: 'after', modeId: null, startedAt: now })
    expect(r.sessions.list()).toHaveLength(1)
    db.close()
  })

  it('works on an empty database without a screenshots folder', () => {
    const r = makeRepos()
    expect(deleteAllData(r.db, { screenshotsDir: join(tempDir(), 'missing') })).toEqual({
      sessions: 0,
      customModes: 0,
      knowledgeFiles: 0,
    })
  })
})
