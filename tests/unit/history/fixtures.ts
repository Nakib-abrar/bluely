import { openDatabase, type Db } from '@main/db/database'
import { ActionItemsRepo } from '@main/db/repos/actionItemsRepo'
import { AiMessagesRepo } from '@main/db/repos/aiMessagesRepo'
import { SessionsRepo } from '@main/db/repos/sessionsRepo'
import { TranscriptRepo } from '@main/db/repos/transcriptRepo'
import { SearchService } from '@main/db/search'
import type { Channel, MeetingNotes, TranscriptLine } from '@shared/types'

export const DAY = 24 * 60 * 60 * 1000
/** Sat, Jan 10, 2026 03:03 UTC */
export const JAN_10_2026 = Date.UTC(2026, 0, 10, 3, 3)

export interface Repos {
  db: Db
  sessions: SessionsRepo
  transcript: TranscriptRepo
  ai: AiMessagesRepo
  actions: ActionItemsRepo
  search: SearchService
}

export function makeRepos(db: Db = openDatabase(':memory:')): Repos {
  return {
    db,
    sessions: new SessionsRepo(db),
    transcript: new TranscriptRepo(db),
    ai: new AiMessagesRepo(db),
    actions: new ActionItemsRepo(db),
    search: new SearchService(db),
  }
}

let seq = 0
export function line(
  sessionId: string,
  channel: Channel,
  startMs: number,
  text: string,
  opts: { id?: string; endMs?: number; isFinal?: boolean } = {},
): TranscriptLine {
  return {
    id: opts.id ?? `line-${++seq}`,
    sessionId,
    channel,
    startMs,
    endMs: opts.endMs ?? startMs + 1000,
    text,
    isFinal: opts.isFinal ?? true,
  }
}

export interface SeedSession {
  id: string
  title?: string
  startedAt: number
  durationMs?: number
  modeId?: string | null
  status?: 'active' | 'processing' | 'done' | 'recovered' | 'failed'
  /** [channel, text] pairs, 5 s apart. */
  lines?: [Channel, string][]
  notes?: MeetingNotes
  notesMarkdown?: string
  emailMarkdown?: string
  actionItems?: { text: string; owner?: string | null; due?: string | null; done?: boolean }[]
}

/** Inserts a finished session with optional transcript, notes, email and action items. */
export function seedSession(r: Repos, s: SeedSession): void {
  r.sessions.create({ id: s.id, modeId: s.modeId ?? null, startedAt: s.startedAt })
  if (s.title) r.sessions.rename(s.id, s.title)
  ;(s.lines ?? []).forEach(([channel, text], i) =>
    r.transcript.upsert(line(s.id, channel, i * 5000, text, { id: `${s.id}-l${i}` })),
  )
  if (s.durationMs != null) r.sessions.end(s.id, s.startedAt + s.durationMs)
  r.sessions.setStatus(s.id, s.status ?? 'done')
  if (s.notes) r.sessions.updateSummaryJson(s.id, { notes: s.notes })
  if (s.notesMarkdown) r.ai.upsertPostCall(s.id, 'post_notes', s.notesMarkdown)
  if (s.emailMarkdown) r.ai.upsertPostCall(s.id, 'post_email', s.emailMarkdown)
  if (s.actionItems) {
    r.actions.replaceForSession(
      s.id,
      s.actionItems.map((a) => ({
        text: a.text,
        owner: a.owner ?? null,
        due: a.due ?? null,
        done: a.done,
      })),
    )
  }
}

export function count(db: Db, sql: string, ...params: unknown[]): number {
  return (db.prepare(sql).get(...params) as { c: number }).c
}

/** Raw FTS lookup (bypasses SearchService) to assert what the index contains. */
export function ftsRefs(db: Db, match: string): string[] {
  return (
    db
      .prepare('SELECT ref_id FROM search_fts WHERE search_fts MATCH ? ORDER BY rowid')
      .all(match) as { ref_id: string }[]
  ).map((r) => r.ref_id)
}
