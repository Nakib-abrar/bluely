import { strToU8, zipSync, type Zippable } from 'fflate'
import { APP_NAME } from '@shared/constants'
import { t } from '@shared/i18n'
import type {
  ActionItem,
  FollowUpEmail,
  KnowledgeFile,
  Mode,
  SessionDetail,
  TranscriptLine,
} from '@shared/types'
import type { Db } from '../db/database'
import { AiMessagesRepo, type AiMessageRecord } from '../db/repos/aiMessagesRepo'
import { SessionsRepo } from '../db/repos/sessionsRepo'
import { ht } from './messages'

// ───────────────────────────── formatting helpers ─────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

interface DateParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  weekday: string
}

const partFormatters = new Map<string, Intl.DateTimeFormat>()

/** Calendar parts of an epoch in `timeZone` (default: the system zone). */
function dateParts(epochMs: number, timeZone?: string): DateParts {
  const key = timeZone ?? ''
  let fmt = partFormatters.get(key)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
      hourCycle: 'h23',
    })
    partFormatters.set(key, fmt)
  }
  const p: Record<string, string> = {}
  for (const part of fmt.formatToParts(new Date(epochMs))) p[part.type] = part.value
  return {
    year: Number(p['year']),
    month: Number(p['month']),
    day: Number(p['day']),
    hour: Number(p['hour']) % 24,
    minute: Number(p['minute']),
    weekday: p['weekday'] ?? '',
  }
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/** "Sat, Jan 10, 2026 · 3:03am" */
export function formatExportDateTime(epochMs: number, timeZone?: string): string {
  const d = dateParts(epochMs, timeZone)
  const h12 = d.hour % 12 || 12
  const suffix = d.hour >= 12 ? 'pm' : 'am'
  return `${d.weekday}, ${MONTHS[d.month - 1] ?? ''} ${d.day}, ${d.year} · ${h12}:${pad2(d.minute)}${suffix}`
}

/** "2026-01-10" */
export function isoDay(epochMs: number, timeZone?: string): string {
  const d = dateParts(epochMs, timeZone)
  return `${d.year}-${pad2(d.month)}-${pad2(d.day)}`
}

/** "2026-01-10-0303" (used for export file names). */
function isoDayMinute(epochMs: number, timeZone?: string): string {
  const d = dateParts(epochMs, timeZone)
  return `${d.year}-${pad2(d.month)}-${pad2(d.day)}-${pad2(d.hour)}${pad2(d.minute)}`
}

/** 5375000 → "1:29:35", 83000 → "1:23" (same as the session list badge). */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '0:00'
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = pad2(total % 60)
  return h > 0 ? `${h}:${pad2(m)}:${s}` : `${m}:${s}`
}

/** Transcript offset: "03:07", or "1:02:03" past the first hour. */
export function formatOffset(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`
}

/** URL/file friendly slug: "Q3 Pricing — Acme!" → "q3-pricing-acme". Keeps non-Latin letters. */
export function slugify(title: string, maxLength = 60): string {
  const slug = title
    .normalize('NFKD')
    // Drop Latin combining accents (é → e) but keep marks that are part of other scripts.
    .replace(/[\u0300-\u036f]/g, '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  const cut = Array.from(slug).slice(0, maxLength).join('').replace(/-+$/g, '')
  return cut || 'meeting'
}

const WINDOWS_RESERVED_CHARS = '<>:"/\\|?*'

/** Makes a string safe as a Windows file name (reserved characters, trailing dots/spaces). */
export function safeFileName(name: string, maxLength = 120): string {
  const cleaned = Array.from(name, (ch) => {
    const code = ch.codePointAt(0) ?? 0
    return code < 0x20 || code === 0x7f || WINDOWS_RESERVED_CHARS.includes(ch) ? ' ' : ch
  })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
  const cut = Array.from(cleaned).slice(0, maxLength).join('')
  return cut.replace(/[. ]+$/g, '') || 'Bluely'
}

/** Default file name for "Export as Markdown": "2026-01-10 Quarterly pricing review.md". */
export function markdownFileName(
  detail: Pick<SessionDetail, 'title' | 'startedAt'>,
  timeZone?: string,
): string {
  const title = detail.title.trim() || ht('untitled')
  return `${safeFileName(`${isoDay(detail.startedAt, timeZone)} ${title}`)}.md`
}

/** Default file name for "Export all data": "bluely-export-2026-01-10.zip". */
export function exportZipFileName(nowMs: number, timeZone?: string): string {
  return `bluely-export-${isoDay(nowMs, timeZone)}.zip`
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function normalizeNewlines(s: string): string {
  return s.replace(/\r\n?/g, '\n')
}

/** "- [x] Send the deck (Me, Friday)" */
export function actionItemLine(item: Pick<ActionItem, 'text' | 'owner' | 'due' | 'done'>): string {
  const meta = [item.owner, item.due]
    .map((v) => (v ? oneLine(v) : ''))
    .filter(Boolean)
    .join(', ')
  return `- [${item.done ? 'x' : ' '}] ${oneLine(item.text)}${meta ? ` (${meta})` : ''}`
}

/** The follow-up email as Markdown; also what is stored (and indexed) as the post_email text. */
export function emailToMarkdown(email: FollowUpEmail): string {
  return `**${ht('mdSubject')}** ${oneLine(email.subject)}\n\n${normalizeNewlines(email.body).trim()}`
}

function speaker(line: TranscriptLine): string {
  return line.channel === 'me' ? t('common.me') : t('common.them')
}

// ───────────────────────────── Markdown export ─────────────────────────────

/**
 * One meeting as Markdown: title, date/duration/mode line, notes, action items, follow-up
 * email and the transcript. Empty sections are left out.
 */
export function sessionToMarkdown(detail: SessionDetail, opts: { timeZone?: string } = {}): string {
  const out: string[] = []
  out.push(`# ${oneLine(detail.title) || ht('untitled')}`)

  const meta = [formatExportDateTime(detail.startedAt, opts.timeZone)]
  if (detail.durationMs != null) {
    meta.push(ht('mdDuration', { duration: formatDuration(detail.durationMs) }))
  }
  if (detail.modeName) meta.push(ht('mdMode', { mode: oneLine(detail.modeName) }))
  out.push(meta.join(' · '))

  const notes = detail.notes
  if (notes?.summary.trim())
    out.push(`## ${ht('mdSummary')}`, normalizeNewlines(notes.summary).trim())
  const bullets = (items: string[] | undefined) =>
    (items ?? [])
      .map(oneLine)
      .filter(Boolean)
      .map((s) => `- ${s}`)
      .join('\n')
  const keyPoints = bullets(notes?.keyPoints)
  if (keyPoints) out.push(`## ${ht('mdKeyPoints')}`, keyPoints)
  const decisions = bullets(notes?.decisions)
  if (decisions) out.push(`## ${ht('mdDecisions')}`, decisions)

  if (detail.actionItems.length) {
    out.push(`## ${ht('mdActionItems')}`, detail.actionItems.map(actionItemLine).join('\n'))
  }

  if (detail.email && (detail.email.subject.trim() || detail.email.body.trim())) {
    out.push(`## ${ht('mdFollowUpEmail')}`, emailToMarkdown(detail.email))
  }

  const lines = detail.transcript.filter((l) => l.text.trim())
  if (lines.length) {
    out.push(
      `## ${ht('mdTranscript')}`,
      lines
        .map((l) => `**${speaker(l)}** [${formatOffset(l.startMs)}]: ${oneLine(l.text)}`)
        .join('\n\n'),
    )
  }
  return `${out.join('\n\n')}\n`
}

// ───────────────────────────── mailto ─────────────────────────────

/** Keeps mailto URLs short enough for Windows' ShellExecute and common mail clients. */
export const MAILTO_MAX_LENGTH = 1900

const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g
const REPLACEMENT_CHAR = String.fromCharCode(0xfffd)

/** Replaces lone surrogates (encodeURIComponent throws on them). */
function wellFormed(s: string): string {
  return s.replace(LONE_SURROGATE_RE, REPLACEMENT_CHAR)
}

/** Longest prefix (by code points) whose encoded form fits in `budget` characters. */
function fitEncoded(text: string, budget: number): string {
  if (budget <= 0) return ''
  let used = 0
  let out = ''
  for (const ch of text) {
    const len = encodeURIComponent(ch).length
    if (used + len > budget) break
    used += len
    out += ch
  }
  return out
}

/**
 * Builds a `mailto:` link for the follow-up email. Line breaks become CRLF (RFC 6068). When the
 * link would exceed ~1900 characters, the body is cut (at a word boundary when possible) and a
 * note asks the user to copy the full email from Bluely.
 */
export function mailtoUrl(email: FollowUpEmail, to = ''): string {
  const recipient = encodeURIComponent(wellFormed(to.trim()))
    .replace(/%40/g, '@')
    .replace(/%2C/gi, ',')
  const notice = `\r\n\r\n${ht('mailTruncated')}`
  const encNotice = encodeURIComponent(notice)

  let subject = wellFormed(oneLine(email.subject))
  const prefixLen = (subj: string) =>
    `mailto:${recipient}?subject=${encodeURIComponent(subj)}&body=`.length
  // An absurdly long subject must not leave the body without room for the truncation notice.
  const maxPrefix = MAILTO_MAX_LENGTH - encNotice.length - 200
  if (prefixLen(subject) > maxPrefix) {
    subject = fitEncoded(subject, maxPrefix - prefixLen(''))
  }
  const prefix = `mailto:${recipient}?subject=${encodeURIComponent(subject)}&body=`

  const body = wellFormed(normalizeNewlines(email.body).trim()).replace(/\n/g, '\r\n')
  const encBody = encodeURIComponent(body)
  if (prefix.length + encBody.length <= MAILTO_MAX_LENGTH) return prefix + encBody

  let cut = fitEncoded(body, MAILTO_MAX_LENGTH - prefix.length - encNotice.length)
  // Prefer not to split a word when a boundary is reasonably close.
  const boundary = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf('\n'))
  if (boundary > cut.length - 80 && boundary > 0) cut = cut.slice(0, boundary)
  cut = cut.replace(/[\s\r\n]+$/, '')
  return prefix + encodeURIComponent(cut) + encNotice
}

// ───────────────────────────── export all ─────────────────────────────

/** Anything that looks like an OpenRouter key or bearer token never leaves via an export. */
function scrubSecrets(value: unknown): unknown {
  if (typeof value === 'string') {
    return value
      .replace(/sk-or-[A-Za-z0-9_-]{8,}/g, '[redacted]')
      .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer [redacted]')
  }
  if (Array.isArray(value)) return value.map(scrubSecrets)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubSecrets(v)]))
  }
  return value
}

type ExportedAiMessage = Omit<AiMessageRecord, 'promptText'>

function withoutPrompt(m: AiMessageRecord): ExportedAiMessage {
  const { promptText: _promptText, ...rest } = m
  return rest
}

interface ModeRow {
  id: string
  name: string
  icon: string
  instructions: string
  tone: Mode['tone']
  auto_suggest: number
  model_overrides_json: string
  is_builtin: number
  sort: number
}

interface KnowledgeFileRow {
  id: string
  mode_id: string
  filename: string
  size: number
  status: KnowledgeFile['status']
  error: string | null
  chunk_count: number
  added_at: number
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export interface ExportAllOptions {
  /** App version written into the JSON (wireHistory passes app.getVersion()). */
  version?: string
  nowMs?: number
  /** Time zone for dates in file names and Markdown (default: system). */
  timeZone?: string
}

/**
 * Everything the user owns as one ZIP: `bluely-export.json` (sessions with notes, email,
 * action items, transcript and AI messages minus prompts; modes; knowledge file metadata;
 * settings) and one Markdown file per session under `sessions/`. The API key lives outside
 * the database and is never included; key-like strings in settings are redacted anyway.
 */
export function exportAllZip(db: Db, opts: ExportAllOptions = {}): Uint8Array {
  const nowMs = opts.nowMs ?? Date.now()
  const sessionsRepo = new SessionsRepo(db)
  const aiRepo = new AiMessagesRepo(db)

  const ids = (
    db.prepare('SELECT id FROM sessions ORDER BY started_at, rowid').all() as { id: string }[]
  ).map((r) => r.id)

  const files: Zippable = {}
  const usedNames = new Set<string>()
  const sessions: unknown[] = []
  for (const id of ids) {
    const detail = sessionsRepo.getDetail(id)
    if (!detail) continue
    sessions.push({ ...detail, aiMessages: aiRepo.listBySession(id).map(withoutPrompt) })

    const base = `sessions/${isoDayMinute(detail.startedAt, opts.timeZone)}-${slugify(detail.title || ht('untitled'))}`
    let name = `${base}.md`
    for (let n = 2; usedNames.has(name); n++) name = `${base}-${n}.md`
    usedNames.add(name)
    files[name] = strToU8(sessionToMarkdown(detail, { timeZone: opts.timeZone }))
  }

  const unattached = (
    db
      .prepare(`SELECT id FROM ai_messages WHERE session_id IS NULL ORDER BY created_at, rowid`)
      .all() as { id: string }[]
  )
    .map((r) => aiRepo.get(r.id))
    .filter((m): m is AiMessageRecord => m !== null)
    .map(withoutPrompt)

  const modes: Mode[] = (
    db.prepare('SELECT * FROM modes ORDER BY sort, name').all() as ModeRow[]
  ).map((r) => ({
    id: r.id,
    name: r.name,
    icon: r.icon,
    instructions: r.instructions,
    tone: r.tone,
    autoSuggest: r.auto_suggest === 1,
    modelOverrides: parseJsonObject(r.model_overrides_json) as Mode['modelOverrides'],
    isBuiltin: r.is_builtin === 1,
    sort: r.sort,
  }))

  const knowledgeFiles: KnowledgeFile[] = (
    db
      .prepare(
        'SELECT id, mode_id, filename, size, status, error, chunk_count, added_at FROM knowledge_files ORDER BY added_at',
      )
      .all() as KnowledgeFileRow[]
  ).map((r) => ({
    id: r.id,
    modeId: r.mode_id,
    filename: r.filename,
    size: r.size,
    status: r.status,
    error: r.error,
    chunkCount: r.chunk_count,
    addedAt: r.added_at,
  }))

  const settings: Record<string, unknown> = {}
  for (const row of db.prepare('SELECT key, value_json FROM settings ORDER BY key').all() as {
    key: string
    value_json: string
  }[]) {
    try {
      settings[row.key] = JSON.parse(row.value_json)
    } catch {
      /* skip corrupt rows */
    }
  }

  const payload = {
    exportedAt: new Date(nowMs).toISOString(),
    app: APP_NAME,
    version: opts.version ?? 'unknown',
    sessions,
    unattachedAiMessages: unattached,
    modes,
    knowledgeFiles,
    settings: scrubSecrets(settings),
  }
  files['bluely-export.json'] = strToU8(JSON.stringify(payload, null, 2))
  return zipSync(files, { level: 6, mtime: new Date(nowMs) })
}
