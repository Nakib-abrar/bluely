import type { Statement } from 'better-sqlite3'
import { z } from 'zod'
import { BUILTIN_MODES } from '@shared/builtinModes'
import type {
  SessionDetail,
  SessionStatus,
  SessionSummary,
  SessionSummaryJson,
} from '@shared/types'
import { ht } from '../../data/messages'
import { AppError } from '../../errors'
import { newId, type Db } from '../database'
import { toNfc } from '../text'
import { ActionItemsRepo } from './actionItemsRepo'
import { TranscriptRepo } from './transcriptRepo'

/** Raw `sessions` row as returned by SQLite. */
export interface SessionRow {
  id: string
  title: string
  mode_id: string | null
  started_at: number
  ended_at: number | null
  duration_ms: number | null
  status: SessionStatus
  summary_json: string | null
  created_at: number
}

export const SESSION_SUMMARY_COLUMNS =
  'id, title, mode_id, started_at, ended_at, duration_ms, status'

export function mapSessionRow(
  row: Pick<
    SessionRow,
    'id' | 'title' | 'mode_id' | 'started_at' | 'ended_at' | 'duration_ms' | 'status'
  >,
): SessionSummary {
  return {
    id: row.id,
    title: row.title,
    modeId: row.mode_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMs: row.duration_ms,
    status: row.status,
  }
}

export const EMPTY_SUMMARY_JSON: Readonly<SessionSummaryJson> = Object.freeze({
  notes: null,
  email: null,
  runningSummary: null,
  postCallError: null,
})

// summary_json is written by several features over time; parse it leniently so one malformed
// field (or an older shape) never makes a whole session unreadable.
const stringList = z.array(z.string()).catch([])
const summaryJsonSchema = z.object({
  notes: z
    .object({
      title: z.string().catch(''),
      summary: z.string().catch(''),
      keyPoints: stringList,
      decisions: stringList,
    })
    .nullable()
    .catch(null),
  email: z
    .object({ subject: z.string().catch(''), body: z.string().catch('') })
    .nullable()
    .catch(null),
  runningSummary: z.string().nullable().catch(null),
  postCallError: z.string().nullable().catch(null),
  emailEdited: z.boolean().optional().catch(undefined),
})

/** Keys updateSummaryJson accepts (EMPTY_SUMMARY_JSON plus the optional flags). */
const SUMMARY_JSON_KEYS: ReadonlySet<string> = new Set([
  ...Object.keys(EMPTY_SUMMARY_JSON),
  'emailEdited',
])

/** Parses a stored summary_json value; missing, corrupt or partial data falls back to defaults. */
export function parseSummaryJson(raw: string | null | undefined): SessionSummaryJson {
  if (!raw) return { ...EMPTY_SUMMARY_JSON }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return { ...EMPTY_SUMMARY_JSON }
  }
  if (typeof value !== 'object' || value === null) return { ...EMPTY_SUMMARY_JSON }
  const parsed = summaryJsonSchema.safeParse({ ...EMPTY_SUMMARY_JSON, ...value })
  return parsed.success ? parsed.data : { ...EMPTY_SUMMARY_JSON }
}

const BUILTIN_MODE_NAMES = new Map(BUILTIN_MODES.map((m) => [m.id, m.name]))

const DEFAULT_LIST_LIMIT = 200
const MAX_LIST_LIMIT = 500

/**
 * Meetings ("sessions"). Every write is a single statement or transaction, so a crash
 * mid-call never leaves a half-written session behind.
 */
export class SessionsRepo {
  private readonly stmt: {
    insert: Statement
    get: Statement
    getWithMode: Statement
    list: Statement
    listBefore: Statement
    rename: Statement
    setTitleIfEmpty: Statement
    end: Statement
    setStatus: Statement
    getSummaryJson: Statement
    setSummaryJson: Statement
    delete: Statement
    deleteOlderThan: Statement
    findUnfinished: Statement
  }
  private readonly transcript: TranscriptRepo
  private readonly actionItems: ActionItemsRepo

  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {
    this.transcript = new TranscriptRepo(db)
    this.actionItems = new ActionItemsRepo(db)
    this.stmt = {
      insert: db.prepare(
        `INSERT INTO sessions(id, title, mode_id, started_at, status, created_at)
         VALUES (@id, '', @modeId, @startedAt, 'active', @createdAt)`,
      ),
      get: db.prepare(`SELECT ${SESSION_SUMMARY_COLUMNS} FROM sessions WHERE id = ?`),
      getWithMode: db.prepare(
        `SELECT s.id, s.title, s.mode_id, s.started_at, s.ended_at, s.duration_ms, s.status,
                s.summary_json, m.name AS mode_name
         FROM sessions s LEFT JOIN modes m ON m.id = s.mode_id
         WHERE s.id = ?`,
      ),
      list: db.prepare(
        `SELECT ${SESSION_SUMMARY_COLUMNS} FROM sessions
         ORDER BY started_at DESC, rowid DESC LIMIT ?`,
      ),
      listBefore: db.prepare(
        `SELECT ${SESSION_SUMMARY_COLUMNS} FROM sessions WHERE started_at < ?
         ORDER BY started_at DESC, rowid DESC LIMIT ?`,
      ),
      rename: db.prepare('UPDATE sessions SET title = ? WHERE id = ?'),
      setTitleIfEmpty: db.prepare(
        "UPDATE sessions SET title = ? WHERE id = ? AND trim(title) = ''",
      ),
      end: db.prepare(
        'UPDATE sessions SET ended_at = @endedAt, duration_ms = max(0, @endedAt - started_at) WHERE id = @id',
      ),
      setStatus: db.prepare('UPDATE sessions SET status = ? WHERE id = ?'),
      getSummaryJson: db.prepare('SELECT summary_json FROM sessions WHERE id = ?'),
      setSummaryJson: db.prepare('UPDATE sessions SET summary_json = ? WHERE id = ?'),
      delete: db.prepare('DELETE FROM sessions WHERE id = ?'),
      // Never touch the session being recorded right now, even if the clock jumped.
      deleteOlderThan: db.prepare(
        "DELETE FROM sessions WHERE started_at < ? AND status <> 'active'",
      ),
      findUnfinished: db.prepare(
        `SELECT ${SESSION_SUMMARY_COLUMNS} FROM sessions WHERE status IN ('active', 'processing')
         ORDER BY started_at ASC`,
      ),
    }
  }

  /** Starts a new meeting record (status 'active', empty title). */
  create(input: { id?: string; modeId: string | null; startedAt: number }): SessionSummary {
    const id = input.id ?? newId()
    this.stmt.insert.run({
      id,
      modeId: input.modeId,
      startedAt: Math.round(input.startedAt),
      createdAt: this.now(),
    })
    return this.mustGet(id)
  }

  get(id: string): SessionSummary | null {
    const row = this.stmt.get.get(id) as SessionRow | undefined
    return row ? mapSessionRow(row) : null
  }

  /** Everything the session page shows: final transcript, action items and post-call outputs. */
  getDetail(id: string): SessionDetail | null {
    const row = this.stmt.getWithMode.get(id) as
      (SessionRow & { mode_name: string | null }) | undefined
    if (!row) return null
    const summary = parseSummaryJson(row.summary_json)
    return {
      ...mapSessionRow(row),
      notes: summary.notes,
      email: summary.email,
      postCallError: summary.postCallError,
      actionItems: this.actionItems.listBySession(id),
      transcript: this.transcript.listBySession(id, { finalOnly: true }),
      // Built-in modes may not be seeded yet (or were deleted); fall back to their known names.
      modeName:
        row.mode_name ?? (row.mode_id ? (BUILTIN_MODE_NAMES.get(row.mode_id) ?? null) : null),
    }
  }

  /** Newest first. Page with `before` = the last `startedAt` of the previous page. */
  list(opts: { limit?: number; before?: number } = {}): SessionSummary[] {
    const limit = clampLimit(opts.limit)
    const rows = (
      opts.before == null ? this.stmt.list.all(limit) : this.stmt.listBefore.all(opts.before, limit)
    ) as SessionRow[]
    return rows.map(mapSessionRow)
  }

  /** Returns false when the session does not exist. */
  rename(id: string, title: string): boolean {
    return this.stmt.rename.run(normalizeTitle(title), id).changes > 0
  }

  /** Auto-title: only applies while the user has not named the session. */
  setTitleIfEmpty(id: string, title: string): boolean {
    const clean = normalizeTitle(title)
    if (!clean) return false
    return this.stmt.setTitleIfEmpty.run(clean, id).changes > 0
  }

  /** Sets ended_at and duration_ms. Status is left to the caller (processing → done). */
  end(id: string, endedAt: number): SessionSummary | null {
    this.stmt.end.run({ id, endedAt: Math.round(endedAt) })
    return this.get(id)
  }

  setStatus(id: string, status: SessionStatus): boolean {
    return this.stmt.setStatus.run(status, id).changes > 0
  }

  /** Defaults (all null) when the session has none yet or does not exist. */
  getSummaryJson(id: string): SessionSummaryJson {
    const row = this.stmt.getSummaryJson.get(id) as { summary_json: string | null } | undefined
    return parseSummaryJson(row?.summary_json)
  }

  /** Shallow merge: keys present in `patch` replace the stored value. Throws 'not_found'. */
  updateSummaryJson(id: string, patch: Partial<SessionSummaryJson>): SessionSummaryJson {
    const tx = this.db.transaction((): SessionSummaryJson => {
      const row = this.stmt.getSummaryJson.get(id) as { summary_json: string | null } | undefined
      if (!row) throw new AppError('not_found', ht('errSessionNotFound'))
      const known = Object.entries(patch).filter(
        ([key, value]) => value !== undefined && SUMMARY_JSON_KEYS.has(key),
      )
      const next: SessionSummaryJson = {
        ...parseSummaryJson(row.summary_json),
        ...(Object.fromEntries(known) as Partial<SessionSummaryJson>),
      }
      this.stmt.setSummaryJson.run(JSON.stringify(next), id)
      return next
    })
    return tx()
  }

  /** Cascades to transcript lines, AI messages and action items (and their search rows). */
  delete(id: string): boolean {
    return this.stmt.delete.run(id).changes > 0
  }

  /** Deletes finished sessions that started before `epochMs`. Returns how many were deleted. */
  deleteOlderThan(epochMs: number): number {
    return this.stmt.deleteOlderThan.run(epochMs).changes
  }

  /** Sessions a crash left 'active' or 'processing', oldest first. */
  findUnfinished(): SessionSummary[] {
    return (this.stmt.findUnfinished.all() as SessionRow[]).map(mapSessionRow)
  }

  private mustGet(id: string): SessionSummary {
    const s = this.get(id)
    if (!s) throw new AppError('not_found', ht('errSessionNotFound'))
    return s
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit == null || !Number.isFinite(limit)) return DEFAULT_LIST_LIMIT
  return Math.min(MAX_LIST_LIMIT, Math.max(1, Math.floor(limit)))
}

/**
 * Single line, trimmed, bounded (titles show up in lists, file names and window titles) and NFC,
 * like all indexed text (see toNfc).
 */
function normalizeTitle(title: string): string {
  return toNfc(title).replace(/\s+/g, ' ').trim().slice(0, 200)
}
