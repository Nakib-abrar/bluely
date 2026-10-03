import type { Statement } from 'better-sqlite3'
import type { Channel, TranscriptLine } from '@shared/types'
import type { Db } from '../database'
import { toNfc } from '../text'

/** Raw `transcript_lines` row. */
export interface TranscriptRow {
  id: string
  session_id: string
  channel: Channel
  start_ms: number
  end_ms: number
  text: string
  is_final: number
}

export const TRANSCRIPT_COLUMNS = 'id, session_id, channel, start_ms, end_ms, text, is_final'

/**
 * Display order shared by every transcript query: by start time; on ties "Them" comes before
 * "Me" (the question is usually what triggered the answer), then insertion order.
 */
export const TRANSCRIPT_ORDER = "start_ms, CASE channel WHEN 'them' THEN 0 ELSE 1 END, rowid"

export function mapTranscriptRow(row: TranscriptRow): TranscriptLine {
  return {
    id: row.id,
    sessionId: row.session_id,
    channel: row.channel,
    startMs: row.start_ms,
    endMs: row.end_ms,
    text: row.text,
    isFinal: row.is_final === 1,
  }
}

/**
 * Transcript lines are written as they arrive (partial and final) so a crash mid-call loses at
 * most the line being spoken. Final lines are indexed for search by triggers.
 */
export class TranscriptRepo {
  private readonly stmt: {
    upsert: Statement
    remove: Statement
    listFinal: Statement
    listAll: Statement
    lastLine: Statement
    countFinal: Statement
    countAll: Statement
    finalizePartials: Statement
    deleteEmptyPartials: Statement
  }

  constructor(private readonly db: Db) {
    this.stmt = {
      // Keeps the row (and its rowid, which the search index is keyed on) on partial → final.
      upsert: db.prepare(
        `INSERT INTO transcript_lines(id, session_id, channel, start_ms, end_ms, text, is_final)
         VALUES (@id, @sessionId, @channel, @startMs, @endMs, @text, @isFinal)
         ON CONFLICT(id) DO UPDATE SET
           text = excluded.text, end_ms = excluded.end_ms, is_final = excluded.is_final`,
      ),
      remove: db.prepare('DELETE FROM transcript_lines WHERE id = ?'),
      listFinal: db.prepare(
        `SELECT ${TRANSCRIPT_COLUMNS} FROM transcript_lines WHERE session_id = ? AND is_final = 1
         ORDER BY ${TRANSCRIPT_ORDER}`,
      ),
      listAll: db.prepare(
        `SELECT ${TRANSCRIPT_COLUMNS} FROM transcript_lines WHERE session_id = ?
         ORDER BY ${TRANSCRIPT_ORDER}`,
      ),
      lastLine: db.prepare(
        `SELECT ${TRANSCRIPT_COLUMNS} FROM transcript_lines WHERE session_id = ?
         ORDER BY end_ms DESC, start_ms DESC, rowid DESC LIMIT 1`,
      ),
      countFinal: db.prepare(
        'SELECT count(*) AS c FROM transcript_lines WHERE session_id = ? AND is_final = 1',
      ),
      countAll: db.prepare('SELECT count(*) AS c FROM transcript_lines WHERE session_id = ?'),
      finalizePartials: db.prepare(
        "UPDATE transcript_lines SET is_final = 1 WHERE session_id = ? AND is_final = 0 AND trim(text) <> ''",
      ),
      deleteEmptyPartials: db.prepare(
        "DELETE FROM transcript_lines WHERE session_id = ? AND is_final = 0 AND trim(text) = ''",
      ),
    }
  }

  /** Inserts a line, or updates text / end_ms / is_final of an existing one (partial → final). */
  upsert(line: TranscriptLine): void {
    this.stmt.upsert.run({
      id: line.id,
      sessionId: line.sessionId,
      channel: line.channel,
      startMs: Math.round(line.startMs),
      endMs: Math.round(line.endMs),
      text: toNfc(line.text),
      isFinal: line.isFinal ? 1 : 0,
    })
  }

  /** Returns false when the line did not exist. */
  remove(id: string): boolean {
    return this.stmt.remove.run(id).changes > 0
  }

  listBySession(sessionId: string, opts: { finalOnly?: boolean } = {}): TranscriptLine[] {
    const stmt = (opts.finalOnly ?? true) ? this.stmt.listFinal : this.stmt.listAll
    return (stmt.all(sessionId) as TranscriptRow[]).map(mapTranscriptRow)
  }

  /**
   * The line that ends last (partial lines included: they still reflect speech that happened).
   * Used to reconstruct the end of a session after a crash.
   */
  lastLine(sessionId: string): TranscriptLine | null {
    const row = this.stmt.lastLine.get(sessionId) as TranscriptRow | undefined
    return row ? mapTranscriptRow(row) : null
  }

  countBySession(sessionId: string, opts: { finalOnly?: boolean } = {}): number {
    const stmt = (opts.finalOnly ?? true) ? this.stmt.countFinal : this.stmt.countAll
    return (stmt.get(sessionId) as { c: number }).c
  }

  /**
   * Promotes the partial lines of a session that can no longer be revised (crash recovery) to
   * final, so they show up in the transcript and in search. Empty partials are dropped.
   * Returns the number of lines promoted.
   */
  finalizeSession(sessionId: string): number {
    const tx = this.db.transaction(() => {
      this.stmt.deleteEmptyPartials.run(sessionId)
      return this.stmt.finalizePartials.run(sessionId).changes
    })
    return tx()
  }
}
