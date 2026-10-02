import type Database from 'better-sqlite3'

export interface Migration {
  version: number
  name: string
  up: (db: Database.Database) => void
}

/*
 * Search index design
 * -------------------
 * search_fts (unicode61 + prefix indexes) and search_trigram (trigram, typo tolerance) hold
 * one row per searchable item. Their rowid is derived from the source row so deletes are
 * O(log n):  rowid = source.rowid * 8 + tag   (tag: 1 title, 2 transcript, 3 notes, 4 action, 5 email)
 *
 * Never run a plain VACUUM (it can renumber implicit rowids). The database uses
 * auto_vacuum=INCREMENTAL; reclaim space with `PRAGMA incremental_vacuum`.
 * If the index ever drifts, call rebuildSearchIndex().
 */

const SEARCH_TABLES = ['search_fts', 'search_trigram'] as const

/** Word tokenizer for the knowledge and search indexes (see migration 2). */
export const FTS_TOKENIZER = `"unicode61 remove_diacritics 2 categories 'L* N* Co M*'"`

function searchTriggers(): string {
  const parts: string[] = []
  for (const t of SEARCH_TABLES) {
    parts.push(`
      CREATE TRIGGER ${t}_sessions_ai AFTER INSERT ON sessions BEGIN
        INSERT INTO ${t}(rowid, text, session_id, kind, ref_id) VALUES (new.rowid * 8 + 1, new.title, new.id, 'title', new.id);
      END;
      CREATE TRIGGER ${t}_sessions_au AFTER UPDATE OF title ON sessions BEGIN
        DELETE FROM ${t} WHERE rowid = old.rowid * 8 + 1;
        INSERT INTO ${t}(rowid, text, session_id, kind, ref_id) VALUES (new.rowid * 8 + 1, new.title, new.id, 'title', new.id);
      END;
      CREATE TRIGGER ${t}_sessions_ad AFTER DELETE ON sessions BEGIN
        DELETE FROM ${t} WHERE rowid = old.rowid * 8 + 1;
      END;

      CREATE TRIGGER ${t}_lines_ai AFTER INSERT ON transcript_lines WHEN new.is_final = 1 BEGIN
        INSERT INTO ${t}(rowid, text, session_id, kind, ref_id) VALUES (new.rowid * 8 + 2, new.text, new.session_id, 'transcript', new.id);
      END;
      CREATE TRIGGER ${t}_lines_au AFTER UPDATE OF text, is_final ON transcript_lines BEGIN
        DELETE FROM ${t} WHERE rowid = old.rowid * 8 + 2;
        INSERT INTO ${t}(rowid, text, session_id, kind, ref_id)
          SELECT new.rowid * 8 + 2, new.text, new.session_id, 'transcript', new.id WHERE new.is_final = 1;
      END;
      CREATE TRIGGER ${t}_lines_ad AFTER DELETE ON transcript_lines BEGIN
        DELETE FROM ${t} WHERE rowid = old.rowid * 8 + 2;
      END;

      CREATE TRIGGER ${t}_ai_ai AFTER INSERT ON ai_messages
        WHEN new.kind IN ('post_notes', 'post_email') AND new.session_id IS NOT NULL AND new.response_text IS NOT NULL BEGIN
        INSERT INTO ${t}(rowid, text, session_id, kind, ref_id)
          VALUES (new.rowid * 8 + (CASE new.kind WHEN 'post_notes' THEN 3 ELSE 5 END), new.response_text, new.session_id,
                  CASE new.kind WHEN 'post_notes' THEN 'notes' ELSE 'email' END, new.id);
      END;
      CREATE TRIGGER ${t}_ai_au AFTER UPDATE OF response_text ON ai_messages
        WHEN new.kind IN ('post_notes', 'post_email') AND new.session_id IS NOT NULL BEGIN
        DELETE FROM ${t} WHERE rowid = old.rowid * 8 + (CASE old.kind WHEN 'post_notes' THEN 3 ELSE 5 END);
        INSERT INTO ${t}(rowid, text, session_id, kind, ref_id)
          SELECT new.rowid * 8 + (CASE new.kind WHEN 'post_notes' THEN 3 ELSE 5 END), new.response_text, new.session_id,
                 CASE new.kind WHEN 'post_notes' THEN 'notes' ELSE 'email' END, new.id
          WHERE new.response_text IS NOT NULL;
      END;
      CREATE TRIGGER ${t}_ai_ad AFTER DELETE ON ai_messages WHEN old.kind IN ('post_notes', 'post_email') BEGIN
        DELETE FROM ${t} WHERE rowid = old.rowid * 8 + (CASE old.kind WHEN 'post_notes' THEN 3 ELSE 5 END);
      END;

      CREATE TRIGGER ${t}_actions_ai AFTER INSERT ON action_items BEGIN
        INSERT INTO ${t}(rowid, text, session_id, kind, ref_id) VALUES (new.rowid * 8 + 4, new.text, new.session_id, 'action_item', new.id);
      END;
      CREATE TRIGGER ${t}_actions_au AFTER UPDATE OF text ON action_items BEGIN
        DELETE FROM ${t} WHERE rowid = old.rowid * 8 + 4;
        INSERT INTO ${t}(rowid, text, session_id, kind, ref_id) VALUES (new.rowid * 8 + 4, new.text, new.session_id, 'action_item', new.id);
      END;
      CREATE TRIGGER ${t}_actions_ad AFTER DELETE ON action_items BEGIN
        DELETE FROM ${t} WHERE rowid = old.rowid * 8 + 4;
      END;
    `)
  }
  return parts.join('\n')
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    up: (db) => {
      db.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL DEFAULT '',
          mode_id TEXT,
          started_at INTEGER NOT NULL,
          ended_at INTEGER,
          duration_ms INTEGER,
          status TEXT NOT NULL DEFAULT 'active'
            CHECK (status IN ('active', 'processing', 'done', 'recovered', 'failed')),
          summary_json TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX idx_sessions_started ON sessions(started_at DESC);
        CREATE INDEX idx_sessions_status ON sessions(status);

        CREATE TABLE transcript_lines (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          channel TEXT NOT NULL CHECK (channel IN ('me', 'them')),
          start_ms INTEGER NOT NULL,
          end_ms INTEGER NOT NULL,
          text TEXT NOT NULL,
          is_final INTEGER NOT NULL DEFAULT 1
        );
        CREATE INDEX idx_lines_session ON transcript_lines(session_id, start_ms);

        CREATE TABLE ai_messages (
          id TEXT PRIMARY KEY,
          session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK (kind IN (
            'auto', 'assist', 'say', 'followups', 'factcheck', 'who', 'recap', 'ask',
            'post_notes', 'post_actions', 'post_email', 'meeting_chat', 'search_ask', 'summary')),
          label TEXT,
          prompt_text TEXT,
          response_text TEXT,
          model TEXT,
          provider TEXT,
          ttft_ms INTEGER,
          total_ms INTEGER,
          tokens_in INTEGER,
          tokens_out INTEGER,
          cost_usd REAL,
          used_screen INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('streaming', 'done', 'error', 'cancelled')),
          error TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX idx_ai_session ON ai_messages(session_id, created_at);
        CREATE INDEX idx_ai_created ON ai_messages(created_at);

        CREATE TABLE action_items (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          text TEXT NOT NULL,
          owner TEXT,
          due TEXT,
          done INTEGER NOT NULL DEFAULT 0,
          sort INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX idx_actions_session ON action_items(session_id, sort);

        CREATE TABLE modes (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          icon TEXT NOT NULL DEFAULT '',
          instructions TEXT NOT NULL DEFAULT '',
          tone TEXT NOT NULL DEFAULT 'concise' CHECK (tone IN ('concise', 'friendly', 'formal')),
          auto_suggest INTEGER NOT NULL DEFAULT 1,
          model_overrides_json TEXT NOT NULL DEFAULT '{}',
          is_builtin INTEGER NOT NULL DEFAULT 0,
          sort INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE knowledge_files (
          id TEXT PRIMARY KEY,
          mode_id TEXT NOT NULL REFERENCES modes(id) ON DELETE CASCADE,
          filename TEXT NOT NULL,
          size INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'parsing', 'parsed', 'failed')),
          error TEXT,
          chunk_count INTEGER NOT NULL DEFAULT 0,
          added_at INTEGER NOT NULL
        );
        CREATE INDEX idx_kfiles_mode ON knowledge_files(mode_id);

        CREATE TABLE knowledge_chunks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          file_id TEXT NOT NULL REFERENCES knowledge_files(id) ON DELETE CASCADE,
          idx INTEGER NOT NULL,
          text TEXT NOT NULL
        );
        CREATE INDEX idx_kchunks_file ON knowledge_chunks(file_id, idx);

        CREATE VIRTUAL TABLE knowledge_chunks_fts USING fts5(
          text,
          content = 'knowledge_chunks',
          content_rowid = 'id',
          tokenize = 'unicode61 remove_diacritics 2'
        );
        CREATE TRIGGER knowledge_chunks_ai AFTER INSERT ON knowledge_chunks BEGIN
          INSERT INTO knowledge_chunks_fts(rowid, text) VALUES (new.id, new.text);
        END;
        CREATE TRIGGER knowledge_chunks_ad AFTER DELETE ON knowledge_chunks BEGIN
          INSERT INTO knowledge_chunks_fts(knowledge_chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
        END;
        CREATE TRIGGER knowledge_chunks_au AFTER UPDATE ON knowledge_chunks BEGIN
          INSERT INTO knowledge_chunks_fts(knowledge_chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
          INSERT INTO knowledge_chunks_fts(rowid, text) VALUES (new.id, new.text);
        END;

        CREATE TABLE settings (
          key TEXT PRIMARY KEY,
          value_json TEXT NOT NULL
        );

        CREATE TABLE model_stats (
          model TEXT NOT NULL,
          provider TEXT NOT NULL DEFAULT '',
          samples INTEGER NOT NULL DEFAULT 0,
          ttft_p50 REAL,
          ttft_p90 REAL,
          total_p50 REAL,
          tps_p50 REAL,
          recent_json TEXT NOT NULL DEFAULT '[]',
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (model, provider)
        );

        CREATE TABLE usage_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at INTEGER NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('llm', 'stt')),
          model TEXT,
          provider TEXT,
          cost_usd REAL,
          tokens_in INTEGER,
          tokens_out INTEGER,
          audio_seconds REAL,
          session_id TEXT
        );
        CREATE INDEX idx_usage_created ON usage_log(created_at);

        CREATE VIRTUAL TABLE search_fts USING fts5(
          text,
          session_id UNINDEXED,
          kind UNINDEXED,
          ref_id UNINDEXED,
          tokenize = 'unicode61 remove_diacritics 2',
          prefix = '2 3 4'
        );
        CREATE VIRTUAL TABLE search_trigram USING fts5(
          text,
          session_id UNINDEXED,
          kind UNINDEXED,
          ref_id UNINDEXED,
          tokenize = 'trigram'
        );
      `)
      db.exec(searchTriggers())
    },
  },
  {
    version: 2,
    name: 'keep combining marks inside FTS tokens (Bangla and other Indic scripts)',
    up: (db) => {
      // unicode61's default categories treat combining marks (Mn/Mc) as separators, so Bangla
      // words such as "আমাদের" were indexed as fragments. Adding M* keeps them whole while
      // remove_diacritics still folds precomposed Latin letters (café → cafe).
      db.exec(`
        DROP TABLE knowledge_chunks_fts;
        CREATE VIRTUAL TABLE knowledge_chunks_fts USING fts5(
          text,
          content = 'knowledge_chunks',
          content_rowid = 'id',
          tokenize = ${FTS_TOKENIZER}
        );
        INSERT INTO knowledge_chunks_fts(knowledge_chunks_fts) VALUES ('rebuild');

        DROP TABLE search_fts;
        CREATE VIRTUAL TABLE search_fts USING fts5(
          text,
          session_id UNINDEXED,
          kind UNINDEXED,
          ref_id UNINDEXED,
          tokenize = ${FTS_TOKENIZER},
          prefix = '2 3 4'
        );
      `)
      rebuildSearchIndex(db)
    },
  },
]

/** Recreates both search indexes from the source tables. */
export function rebuildSearchIndex(db: Database.Database): void {
  const tx = db.transaction(() => {
    for (const t of SEARCH_TABLES) {
      db.exec(`DELETE FROM ${t};`)
      db.exec(`
        INSERT INTO ${t}(rowid, text, session_id, kind, ref_id)
          SELECT rowid * 8 + 1, title, id, 'title', id FROM sessions;
        INSERT INTO ${t}(rowid, text, session_id, kind, ref_id)
          SELECT rowid * 8 + 2, text, session_id, 'transcript', id FROM transcript_lines WHERE is_final = 1;
        INSERT INTO ${t}(rowid, text, session_id, kind, ref_id)
          SELECT rowid * 8 + (CASE kind WHEN 'post_notes' THEN 3 ELSE 5 END), response_text, session_id,
                 CASE kind WHEN 'post_notes' THEN 'notes' ELSE 'email' END, id
          FROM ai_messages
          WHERE kind IN ('post_notes', 'post_email') AND session_id IS NOT NULL AND response_text IS NOT NULL;
        INSERT INTO ${t}(rowid, text, session_id, kind, ref_id)
          SELECT rowid * 8 + 4, text, session_id, 'action_item', id FROM action_items;
      `)
    }
  })
  tx()
}

export function runMigrations(db: Database.Database): { from: number; to: number } {
  const from = db.pragma('user_version', { simple: true }) as number
  if (from === 0) {
    // Must be set before the first table exists to take effect without a VACUUM.
    db.pragma('auto_vacuum = INCREMENTAL')
  }
  let current = from
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue
    const tx = db.transaction(() => {
      m.up(db)
      db.pragma(`user_version = ${m.version}`)
    })
    tx()
    current = m.version
  }
  return { from, to: current }
}

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0
