import { stat } from 'node:fs/promises'
import { basename, isAbsolute } from 'node:path'
import { KNOWLEDGE_LIMITS } from '@shared/constants'
import type { KnowledgeFile, KnowledgeFileStatus } from '@shared/types'
import { AppError } from '../errors'
import { newId, type Db } from '../db/database'
import type { EventBus } from '../ipc/events'
import type { Logger } from '../log'
import { chunkText } from './chunker'
import { KnowledgeError, knowledgeMessages, reasons } from './messages'
import { extractText, knowledgeExtension, toKnowledgeError, type ExtractedText } from './parsers'

export interface KnowledgeServiceDeps {
  db: Db
  events: Pick<EventBus, 'broadcast'>
  log: Logger
  now?: () => number
  /** Injection points for tests; default to the real parser and chunker. */
  extract?: (filePath: string) => Promise<ExtractedText>
  chunk?: (text: string) => string[]
}

interface FileRow {
  id: string
  mode_id: string
  filename: string
  size: number
  status: KnowledgeFileStatus
  error: string | null
  chunk_count: number
  added_at: number
}

/** A validated file waiting to be parsed. */
interface PendingJob {
  id: string
  path: string
}

const SELECT_FILE = `SELECT id, mode_id, filename, size, status, error, chunk_count, added_at
  FROM knowledge_files`

/**
 * Ingests knowledge files for a Mode: validates them, extracts text, chunks it and stores the
 * chunks (FTS5-indexed by triggers). Only extracted text is stored, never a copy of the file.
 *
 * Every status change broadcasts 'knowledge:changed' with the Mode's full file list. Files are
 * processed one at a time across all calls (a queue), so a big batch never parses several PDFs
 * concurrently on the main thread.
 */
export class KnowledgeService {
  private readonly db: Db
  private readonly events: Pick<EventBus, 'broadcast'>
  private readonly log: Logger
  private readonly now: () => number
  private readonly extract: (filePath: string) => Promise<ExtractedText>
  private readonly chunk: (text: string) => string[]
  private queue: Promise<void> = Promise.resolve()

  constructor(deps: KnowledgeServiceDeps) {
    this.db = deps.db
    this.events = deps.events
    this.log = deps.log
    this.now = deps.now ?? Date.now
    this.extract = deps.extract ?? extractText
    this.chunk = deps.chunk ?? ((text) => chunkText(text))
  }

  /** The Mode's files, oldest first. */
  list(modeId: string): KnowledgeFile[] {
    const rows = this.db
      .prepare<[string], FileRow>(`${SELECT_FILE} WHERE mode_id = ? ORDER BY added_at, rowid`)
      .all(modeId)
    return rows.map(toKnowledgeFile)
  }

  /** One file by id, or null. */
  get(fileId: string): KnowledgeFile | null {
    const row = this.db.prepare<[string], FileRow>(`${SELECT_FILE} WHERE id = ?`).get(fileId)
    return row ? toKnowledgeFile(row) : null
  }

  /**
   * Adds files to a Mode and processes them. Invalid files (wrong type, too large, unreadable,
   * over the per-Mode limit) become 'failed' rows with a friendly reason; a file with the same
   * name as an existing one (case-insensitive) replaces it, even if the new copy then fails, so
   * the list always reflects the latest file the user added. The limit counts files that are not
   * 'failed'. Resolves with this batch's rows in their final state, in input order (rows deleted
   * meanwhile are left out). One bad file never aborts the batch.
   */
  async addFiles(modeId: string, paths: string[]): Promise<KnowledgeFile[]> {
    this.assertModeExists(modeId)
    if (!paths.length) return []

    // Later duplicates within one batch win, like re-adding a file.
    const byName = new Map<string, string>()
    for (const p of paths) byName.set(nameKey(basename(p)), p)
    const candidates = await Promise.all(
      [...byName.values()].map(async (path) => ({ path, check: await precheck(path) })),
    )

    // Everything below up to the broadcast is synchronous, so concurrent addFiles() calls
    // cannot both squeeze under the per-Mode limit.
    this.assertModeExists(modeId)
    const existing = this.db
      .prepare<[string], FileRow>(`${SELECT_FILE} WHERE mode_id = ?`)
      .all(modeId)
    const existingByName = new Map(existing.map((r) => [nameKey(r.filename), r]))
    let active = existing.filter((r) => r.status !== 'failed').length

    const ids: string[] = []
    const jobs: PendingJob[] = []
    const insert = this.db.prepare(
      `INSERT INTO knowledge_files(id, mode_id, filename, size, status, error, chunk_count, added_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
    )
    const remove = this.db.prepare('DELETE FROM knowledge_files WHERE id = ?')
    const addedAt = this.now()

    this.db.transaction(() => {
      for (const { path, check } of candidates) {
        const filename = basename(path)
        const replaced = existingByName.get(nameKey(filename))
        if (replaced) {
          remove.run(replaced.id)
          existingByName.delete(nameKey(filename))
          if (replaced.status !== 'failed') active--
        }
        let error = check.error
        if (!error && active >= KNOWLEDGE_LIMITS.maxFilesPerMode) error = reasons.modeFull
        const id = newId()
        insert.run(id, modeId, filename, check.size, error ? 'failed' : 'pending', error, addedAt)
        ids.push(id)
        if (!error) {
          active++
          jobs.push({ id, path })
        }
      }
    })()
    this.emit(modeId)

    if (jobs.length) await this.enqueue(() => this.processJobs(modeId, jobs))

    const order = new Map(ids.map((id, i) => [id, i]))
    return this.list(modeId)
      .filter((f) => order.has(f.id))
      .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
  }

  /** Deletes one file and its chunks (and their FTS rows, via triggers). No-op if missing. */
  delete(fileId: string): void {
    const row = this.db
      .prepare<[string], { mode_id: string }>('SELECT mode_id FROM knowledge_files WHERE id = ?')
      .get(fileId)
    if (!row) return
    this.db.prepare('DELETE FROM knowledge_files WHERE id = ?').run(fileId)
    this.emit(row.mode_id)
  }

  /** Deletes every file of a Mode (used when the Mode itself is deleted). */
  deleteForMode(modeId: string): void {
    const { changes } = this.db.prepare('DELETE FROM knowledge_files WHERE mode_id = ?').run(modeId)
    if (changes > 0) this.emit(modeId)
  }

  /**
   * Marks files left 'pending'/'parsing' by a previous run (crash or quit mid-ingest) as failed.
   * The source path is never stored, so they cannot be resumed. Call once at startup, before
   * any addFiles().
   */
  recoverInterrupted(): number {
    const stale = this.db
      .prepare<[], { mode_id: string }>(
        "SELECT DISTINCT mode_id FROM knowledge_files WHERE status IN ('pending', 'parsing')",
      )
      .all()
    if (!stale.length) return 0
    const { changes } = this.db
      .prepare(
        "UPDATE knowledge_files SET status = 'failed', error = ? WHERE status IN ('pending', 'parsing')",
      )
      .run(reasons.interrupted)
    for (const { mode_id } of stale) this.emit(mode_id)
    this.log.warn(`Marked ${changes} interrupted knowledge file(s) as failed`)
    return changes
  }

  /** Resolves when every queued file has been processed (for shutdown and tests). */
  idle(): Promise<void> {
    return this.queue
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task, task)
    // Keep the chain alive even if a task throws; each caller still sees its own result.
    this.queue = run.catch(() => undefined)
    return run
  }

  private async processJobs(modeId: string, jobs: PendingJob[]): Promise<void> {
    for (const job of jobs) {
      try {
        await this.processOne(modeId, job)
      } catch (err) {
        // processOne handles expected failures; this is a last line of defence for the batch
        // (e.g. the database refusing the chunk insert).
        this.log.error('Knowledge ingest failed unexpectedly', err)
        try {
          this.setFailed(modeId, job.id, reasons.unreadable(knowledgeMessages.details.unknown))
        } catch (inner) {
          this.log.error('Could not mark knowledge file as failed', inner)
        }
      }
    }
  }

  private async processOne(modeId: string, job: PendingJob): Promise<void> {
    if (!this.setStatus(job.id, 'parsing')) return // deleted while queued
    this.emit(modeId)

    let chunks: string[]
    try {
      const { text } = await this.extract(job.path)
      chunks = this.chunk(text).filter((c) => c.trim().length > 0)
      if (!chunks.length) throw new KnowledgeError(reasons.empty)
    } catch (err) {
      const kerr = toKnowledgeError(err)
      if (!(err instanceof KnowledgeError)) this.log.warn('Knowledge file failed to parse', err)
      this.setFailed(modeId, job.id, kerr.reason)
      return
    }

    const stored = this.db.transaction(() => {
      // The file (or its Mode) may have been deleted while we were parsing.
      const alive = this.db.prepare('SELECT 1 FROM knowledge_files WHERE id = ?').get(job.id)
      if (!alive) return false
      const ins = this.db.prepare(
        'INSERT INTO knowledge_chunks(file_id, idx, text) VALUES (?, ?, ?)',
      )
      chunks.forEach((text, idx) => ins.run(job.id, idx, text))
      this.db
        .prepare(
          "UPDATE knowledge_files SET status = 'parsed', error = NULL, chunk_count = ? WHERE id = ?",
        )
        .run(chunks.length, job.id)
      return true
    })()
    if (stored) this.emit(modeId)
  }

  private setStatus(fileId: string, status: KnowledgeFileStatus): boolean {
    const { changes } = this.db
      .prepare('UPDATE knowledge_files SET status = ? WHERE id = ?')
      .run(status, fileId)
    return changes > 0
  }

  private setFailed(modeId: string, fileId: string, reason: string): void {
    const { changes } = this.db
      .prepare(
        "UPDATE knowledge_files SET status = 'failed', error = ?, chunk_count = 0 WHERE id = ?",
      )
      .run(reason, fileId)
    if (changes > 0) this.emit(modeId)
  }

  private assertModeExists(modeId: string): void {
    const found = this.db.prepare('SELECT 1 FROM modes WHERE id = ?').get(modeId)
    if (!found) throw new AppError('not_found', knowledgeMessages.modes.notFound)
  }

  private emit(modeId: string): void {
    this.events.broadcast('knowledge:changed', { modeId, files: this.list(modeId) })
  }
}

/** Filenames compare case-insensitively: Windows treats "Report.pdf" and "report.pdf" as one. */
function nameKey(filename: string): string {
  return filename.normalize('NFC').toLowerCase()
}

/** Cheap checks before a row is created: path shape, extension, existence, size. */
async function precheck(path: string): Promise<{ size: number; error: string | null }> {
  if (!isAbsolute(path)) {
    return { size: 0, error: reasons.unreadable(knowledgeMessages.details.invalidPath) }
  }
  if (!knowledgeExtension(path)) return { size: 0, error: reasons.unsupportedType }
  try {
    const info = await stat(path)
    if (!info.isFile()) {
      return { size: 0, error: reasons.unreadable(knowledgeMessages.details.notAFile) }
    }
    if (info.size > KNOWLEDGE_LIMITS.maxFileBytes)
      return { size: info.size, error: reasons.tooLarge }
    if (info.size === 0) return { size: 0, error: reasons.empty }
    return { size: info.size, error: null }
  } catch (err) {
    return { size: 0, error: toKnowledgeError(err).reason }
  }
}

function toKnowledgeFile(row: FileRow): KnowledgeFile {
  return {
    id: row.id,
    modeId: row.mode_id,
    filename: row.filename,
    size: row.size,
    status: row.status,
    error: row.error,
    chunkCount: row.chunk_count,
    addedAt: row.added_at,
  }
}
