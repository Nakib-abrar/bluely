import { rmSync } from 'node:fs'
import type { Db } from '../db/database'
import type { AppPaths } from '../env'
import { reclaimSpace } from './retention'

export interface DeleteAllResult {
  sessions: number
  customModes: number
  knowledgeFiles: number
}

const FTS_TABLES = ['search_fts', 'search_trigram', 'knowledge_chunks_fts'] as const

/**
 * Settings › Privacy & Data › Delete all data. Removes every meeting (with transcripts, AI
 * messages and action items through FK cascades), remaining AI messages, usage and latency
 * stats, knowledge files (chunks cascade) and custom modes, plus saved screenshots. Built-in
 * modes, settings and the API key are kept so the app keeps working.
 *
 * Deleted content should not linger on disk either: secure_delete zeroes freed pages, the
 * full-text indexes are merged so no deleted terms survive in old segments, and the WAL is
 * checkpointed and truncated.
 */
export function deleteAllData(db: Db, paths: Pick<AppPaths, 'screenshotsDir'>): DeleteAllResult {
  const previousSecureDelete = db.pragma('secure_delete', { simple: true }) as number
  db.pragma('secure_delete = ON')
  try {
    const tx = db.transaction((): DeleteAllResult => {
      const sessions = db.prepare('DELETE FROM sessions').run().changes
      db.prepare('DELETE FROM ai_messages').run()
      db.prepare('DELETE FROM usage_log').run()
      db.prepare('DELETE FROM model_stats').run()
      const knowledgeFiles = db.prepare('DELETE FROM knowledge_files').run().changes
      // Chunks normally cascade; this also catches rows written without foreign keys enforced.
      db.prepare('DELETE FROM knowledge_chunks').run()
      const customModes = db.prepare('DELETE FROM modes WHERE is_builtin = 0').run().changes
      for (const t of FTS_TABLES) db.prepare(`INSERT INTO ${t}(${t}) VALUES ('optimize')`).run()
      return { sessions, customModes, knowledgeFiles }
    })
    const result = tx()
    reclaimSpace(db)
    db.pragma('wal_checkpoint(TRUNCATE)')
    rmSync(paths.screenshotsDir, { recursive: true, force: true })
    return result
  } finally {
    db.pragma(`secure_delete = ${Number(previousSecureDelete) || 0}`)
  }
}
