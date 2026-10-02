import type { Statement } from 'better-sqlite3'
import type {
  AiCard,
  AiCardScope,
  AiCardStatus,
  AiErrorInfo,
  AiMessageKind,
  ProviderErrorCode,
  SpeedStats,
  Tier,
} from '@shared/types'
import { newId, type Db } from '../database'

/** Raw `ai_messages` row. */
export interface AiMessageRow {
  id: string
  session_id: string | null
  kind: AiMessageKind
  label: string | null
  prompt_text: string | null
  response_text: string | null
  model: string | null
  provider: string | null
  ttft_ms: number | null
  total_ms: number | null
  tokens_in: number | null
  tokens_out: number | null
  cost_usd: number | null
  used_screen: number
  status: AiCardStatus
  error: string | null
  created_at: number
}

/** A stored AI request/answer in camelCase. */
export interface AiMessageRecord {
  id: string
  sessionId: string | null
  kind: AiMessageKind
  label: string | null
  promptText: string | null
  responseText: string | null
  model: string | null
  provider: string | null
  ttftMs: number | null
  totalMs: number | null
  tokensIn: number | null
  tokensOut: number | null
  costUsd: number | null
  usedScreen: boolean
  status: AiCardStatus
  error: AiErrorInfo | null
  createdAt: number
}

export interface AiMessageInsert {
  id: string
  sessionId: string | null
  kind: AiMessageKind
  /** Card label; for typed questions ('ask', 'meeting_chat', 'search_ask') the question itself. */
  label: string | null
  promptText: string | null
  /** Defaults to 'streaming'. */
  status?: AiCardStatus
  createdAt: number
  usedScreen: boolean
}

export interface AiMessageCompletion {
  responseText?: string | null
  model?: string | null
  provider?: string | null
  ttftMs?: number | null
  totalMs?: number | null
  tokensIn?: number | null
  tokensOut?: number | null
  costUsd?: number | null
  status: Exclude<AiCardStatus, 'streaming'>
  /** Stored as JSON when structured; a plain string is kept as the message. */
  error?: AiErrorInfo | string | null
}

export type PostCallKind = 'post_notes' | 'post_actions' | 'post_email'

/** Generation stats for a post-call output. A SpeedStats object fits as-is. */
export interface PostCallStats {
  model?: string | null
  provider?: string | null
  ttftMs?: number | null
  totalMs?: number | null
  tokensIn?: number | null
  tokensOut?: number | null
  costUsd?: number | null
  promptText?: string | null
}

/** Kinds shown as cards in the live overlay. */
export const LIVE_AI_KINDS: readonly AiMessageKind[] = [
  'auto',
  'assist',
  'say',
  'followups',
  'factcheck',
  'who',
  'recap',
  'ask',
]

const QUESTION_KINDS: ReadonlySet<AiMessageKind> = new Set(['ask', 'meeting_chat', 'search_ask'])
const FAST_KINDS: ReadonlySet<AiMessageKind> = new Set([
  'auto',
  'say',
  'followups',
  'factcheck',
  'who',
  'recap',
])

const PROVIDER_ERROR_CODES: ReadonlySet<string> = new Set<ProviderErrorCode>([
  'no_key',
  'auth',
  'credits',
  'rate_limit',
  'server',
  'timeout',
  'network',
  'bad_request',
  'moderation',
  'aborted',
  'model_unavailable',
  'unknown',
])

const COLUMNS =
  'id, session_id, kind, label, prompt_text, response_text, model, provider, ttft_ms, total_ms, ' +
  'tokens_in, tokens_out, cost_usd, used_screen, status, error, created_at'

function serializeError(error: AiErrorInfo | string | null | undefined): string | null {
  if (error == null) return null
  return typeof error === 'string' ? error : JSON.stringify(error)
}

/** Inverse of serializeError; tolerates plain-text errors written by older code. */
export function parseStoredError(raw: string | null): AiErrorInfo | null {
  if (raw == null || raw === '') return null
  try {
    const v: unknown = JSON.parse(raw)
    if (typeof v === 'object' && v !== null) {
      const o = v as Record<string, unknown>
      if (typeof o['message'] === 'string') {
        const code = typeof o['code'] === 'string' ? o['code'] : 'unknown'
        return {
          code: (PROVIDER_ERROR_CODES.has(code) ? code : 'unknown') as ProviderErrorCode,
          message: o['message'],
          retryable: o['retryable'] === true,
          retryAfterSec: typeof o['retryAfterSec'] === 'number' ? o['retryAfterSec'] : null,
        }
      }
    }
  } catch {
    /* plain text */
  }
  return { code: 'unknown', message: raw, retryable: false, retryAfterSec: null }
}

/** Same formula as the streaming client: completion tokens over the generation phase. */
export function tokensPerSecond(
  tokensOut: number | null,
  totalMs: number | null,
  ttftMs: number | null,
): number | null {
  if (tokensOut == null || tokensOut <= 0 || totalMs == null) return null
  const genMs = ttftMs != null && totalMs > ttftMs ? totalMs - ttftMs : totalMs
  return genMs > 0 ? tokensOut / (genMs / 1000) : null
}

export function mapAiMessageRow(row: AiMessageRow): AiMessageRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    kind: row.kind,
    label: row.label,
    promptText: row.prompt_text,
    responseText: row.response_text,
    model: row.model,
    provider: row.provider,
    ttftMs: row.ttft_ms,
    totalMs: row.total_ms,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    costUsd: row.cost_usd,
    usedScreen: row.used_screen === 1,
    status: row.status,
    error: parseStoredError(row.error),
    createdAt: row.created_at,
  }
}

/**
 * Rebuilds the card a renderer shows from a stored message. The tier is not stored, so it is
 * inferred from the kind (one-click actions run on Fast, typed questions default to Smart).
 */
export function recordToCard(rec: AiMessageRecord, scope: AiCardScope): AiCard {
  const stats: SpeedStats | null =
    rec.model && rec.totalMs != null
      ? {
          ttftMs: rec.ttftMs,
          totalMs: rec.totalMs,
          tokensPerSec: tokensPerSecond(rec.tokensOut, rec.totalMs, rec.ttftMs),
          tokensIn: rec.tokensIn,
          tokensOut: rec.tokensOut,
          costUsd: rec.costUsd,
          provider: rec.provider,
          model: rec.model,
          generationId: null,
        }
      : null
  const tier: Tier = FAST_KINDS.has(rec.kind) ? 'fast' : 'smart'
  return {
    id: rec.id,
    scope,
    sessionId: rec.sessionId,
    kind: rec.kind,
    label: rec.label ?? '',
    question: QUESTION_KINDS.has(rec.kind) ? (rec.label ?? null) : null,
    usedScreen: rec.usedScreen,
    tier,
    status: rec.status,
    text: rec.responseText ?? '',
    error: rec.error,
    stats,
    citations: [],
    createdAt: rec.createdAt,
  }
}

/** Every AI request and answer (live cards, post-call outputs, meeting chat, search answers). */
export class AiMessagesRepo {
  private readonly stmt: {
    insert: Statement
    insertPostCall: Statement
    complete: Statement
    get: Statement
    listBySession: Statement
    listBySessionKinds: Statement
    idsOfKind: Statement
    deleteById: Statement
    setPostCallStats: Statement
    setPostCallText: Statement
    markInterrupted: Statement
  }

  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {
    this.stmt = {
      insert: db.prepare(
        `INSERT INTO ai_messages(id, session_id, kind, label, prompt_text, used_screen, status, created_at)
         VALUES (@id, @sessionId, @kind, @label, @promptText, @usedScreen, @status, @createdAt)`,
      ),
      insertPostCall: db.prepare(
        `INSERT INTO ai_messages(id, session_id, kind, label, prompt_text, response_text, model,
           provider, ttft_ms, total_ms, tokens_in, tokens_out, cost_usd, used_screen, status, error,
           created_at)
         VALUES (@id, @sessionId, @kind, NULL, @promptText, @responseText, @model, @provider,
           @ttftMs, @totalMs, @tokensIn, @tokensOut, @costUsd, 0, 'done', NULL, @createdAt)`,
      ),
      complete: db.prepare(
        `UPDATE ai_messages SET response_text = @responseText, model = @model, provider = @provider,
           ttft_ms = @ttftMs, total_ms = @totalMs, tokens_in = @tokensIn, tokens_out = @tokensOut,
           cost_usd = @costUsd, status = @status, error = @error
         WHERE id = @id`,
      ),
      get: db.prepare(`SELECT ${COLUMNS} FROM ai_messages WHERE id = ?`),
      listBySession: db.prepare(
        `SELECT ${COLUMNS} FROM ai_messages WHERE session_id = ? ORDER BY created_at, rowid`,
      ),
      listBySessionKinds: db.prepare(
        `SELECT ${COLUMNS} FROM ai_messages
         WHERE session_id = ? AND kind IN (SELECT value FROM json_each(?))
         ORDER BY created_at, rowid`,
      ),
      idsOfKind: db.prepare(
        `SELECT id FROM ai_messages WHERE session_id = ? AND kind = ?
         ORDER BY created_at DESC, rowid DESC`,
      ),
      deleteById: db.prepare('DELETE FROM ai_messages WHERE id = ?'),
      setPostCallStats: db.prepare(
        `UPDATE ai_messages SET prompt_text = @promptText, model = @model, provider = @provider,
           ttft_ms = @ttftMs, total_ms = @totalMs, tokens_in = @tokensIn, tokens_out = @tokensOut,
           cost_usd = @costUsd, created_at = @createdAt
         WHERE id = @id`,
      ),
      setPostCallText: db.prepare(
        "UPDATE ai_messages SET response_text = ?, status = 'done', error = NULL WHERE id = ?",
      ),
      markInterrupted: db.prepare(
        "UPDATE ai_messages SET status = 'cancelled' WHERE status = 'streaming'",
      ),
    }
  }

  insert(msg: AiMessageInsert): void {
    this.stmt.insert.run({
      id: msg.id,
      sessionId: msg.sessionId,
      kind: msg.kind,
      label: msg.label,
      promptText: msg.promptText,
      usedScreen: msg.usedScreen ? 1 : 0,
      status: msg.status ?? 'streaming',
      createdAt: msg.createdAt,
    })
  }

  /** Records the outcome of a streamed request. Returns false for unknown ids. */
  complete(id: string, result: AiMessageCompletion): boolean {
    return (
      this.stmt.complete.run({
        id,
        responseText: result.responseText ?? null,
        model: result.model ?? null,
        provider: result.provider ?? null,
        ttftMs: roundOrNull(result.ttftMs),
        totalMs: roundOrNull(result.totalMs),
        tokensIn: roundOrNull(result.tokensIn),
        tokensOut: roundOrNull(result.tokensOut),
        costUsd: result.costUsd ?? null,
        status: result.status,
        error: serializeError(result.error),
      }).changes > 0
    )
  }

  get(id: string): AiMessageRecord | null {
    const row = this.stmt.get.get(id) as AiMessageRow | undefined
    return row ? mapAiMessageRow(row) : null
  }

  /** Oldest first, optionally limited to some kinds. */
  listBySession(sessionId: string, kinds?: readonly AiMessageKind[]): AiMessageRecord[] {
    const rows = (
      kinds
        ? this.stmt.listBySessionKinds.all(sessionId, JSON.stringify(kinds))
        : this.stmt.listBySession.all(sessionId)
    ) as AiMessageRow[]
    return rows.map(mapAiMessageRow)
  }

  /**
   * Stores a post-call output as the single row of its kind for the session. Updating in place
   * keeps the search index (maintained by triggers on response_text) pointing at one current
   * row. Without `stats` (e.g. the user edited the email) the generation stats are kept.
   * Returns the row id.
   */
  upsertPostCall(
    sessionId: string,
    kind: PostCallKind,
    responseText: string,
    stats?: PostCallStats,
  ): string {
    const tx = this.db.transaction((): string => {
      const ids = (this.stmt.idsOfKind.all(sessionId, kind) as { id: string }[]).map((r) => r.id)
      const [keep, ...extra] = ids
      for (const id of extra) this.stmt.deleteById.run(id)
      const createdAt = this.now()
      if (keep) {
        if (stats) this.stmt.setPostCallStats.run({ id: keep, createdAt, ...statsParams(stats) })
        this.stmt.setPostCallText.run(responseText, keep)
        return keep
      }
      const id = newId()
      this.stmt.insertPostCall.run({
        id,
        sessionId,
        kind,
        responseText,
        createdAt,
        ...statsParams(stats ?? {}),
      })
      return id
    })
    return tx()
  }

  /** Meeting chat history of a session as cards, oldest first. */
  chatHistory(sessionId: string): AiCard[] {
    return this.listBySession(sessionId, ['meeting_chat']).map((r) =>
      recordToCard(r, 'meeting_chat'),
    )
  }

  /** Live overlay cards of a session, oldest first. */
  liveCards(sessionId: string): AiCard[] {
    return this.listBySession(sessionId, LIVE_AI_KINDS).map((r) => recordToCard(r, 'live'))
  }

  /**
   * Nothing can be streaming before the app wires its features, so rows still marked
   * 'streaming' are leftovers of a crash. Marks them cancelled; returns how many.
   */
  markInterrupted(): number {
    return this.stmt.markInterrupted.run().changes
  }
}

function roundOrNull(v: number | null | undefined): number | null {
  return v == null || !Number.isFinite(v) ? null : Math.round(v)
}

function statsParams(stats: PostCallStats) {
  return {
    promptText: stats.promptText ?? null,
    model: stats.model ?? null,
    provider: stats.provider ?? null,
    ttftMs: roundOrNull(stats.ttftMs),
    totalMs: roundOrNull(stats.totalMs),
    tokensIn: roundOrNull(stats.tokensIn),
    tokensOut: roundOrNull(stats.tokensOut),
    costUsd: stats.costUsd ?? null,
  }
}
