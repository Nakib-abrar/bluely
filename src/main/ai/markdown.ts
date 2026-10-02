import type { FollowUpEmail, MeetingNotes, SessionDetail } from '@shared/types'
import {
  formatDateTime,
  formatDuration,
  formatTimestamp,
  mergeTranscriptLines,
  usableLines,
} from './format'
import { defaultMarkdownLabels, type MarkdownLabels } from './labels'

/** Plain action item shape (post-call output or a stored ActionItem). */
export interface ActionItemLike {
  text: string
  owner: string | null
  due: string | null
  done?: boolean
}

export interface MarkdownOptions {
  /** Overrides for section labels (defaults are English; Me/Them come from i18n). */
  labels?: Partial<MarkdownLabels>
}

function labelsFrom(opts?: MarkdownOptions): MarkdownLabels {
  return { ...defaultMarkdownLabels(), ...opts?.labels }
}

/** Collapses newlines so one item stays one Markdown list entry. */
function inline(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function bulletList(items: string[]): string {
  return items
    .map(inline)
    .filter((s) => s.length > 0)
    .map((s) => `- ${s}`)
    .join('\n')
}

/**
 * Meeting notes as Markdown sections (Summary, Key points, Decisions). Empty sections are
 * omitted. `title: true` adds the notes title as a level-1 heading.
 */
export function renderNotesMarkdown(
  notes: MeetingNotes,
  opts: MarkdownOptions & { title?: boolean } = {},
): string {
  const l = labelsFrom(opts)
  const parts: string[] = []
  if (opts.title && notes.title.trim()) parts.push(`# ${inline(notes.title)}`)
  if (notes.summary.trim()) parts.push(`## ${l.summary}\n${notes.summary.trim()}`)
  const keyPoints = bulletList(notes.keyPoints)
  if (keyPoints) parts.push(`## ${l.keyPoints}\n${keyPoints}`)
  const decisions = bulletList(notes.decisions)
  if (decisions) parts.push(`## ${l.decisions}\n${decisions}`)
  return parts.join('\n\n')
}

/** `- [x] text — owner, due` per item (owner/due only when present). */
export function renderActionItemsMarkdown(items: ActionItemLike[]): string {
  return items
    .map((item) => {
      const text = inline(item.text)
      if (!text) return null
      const meta = [item.owner, item.due]
        .map((v) => inline(v ?? ''))
        .filter((v) => v.length > 0)
        .join(', ')
      return `- [${item.done ? 'x' : ' '}] ${text}${meta ? ` — ${meta}` : ''}`
    })
    .filter((line): line is string => line !== null)
    .join('\n')
}

/** Copy-ready email: "Subject: …", a blank line, then the body. */
export function renderEmailText(email: FollowUpEmail, opts: MarkdownOptions = {}): string {
  const l = labelsFrom(opts)
  const subject = inline(email.subject)
  const body = email.body.replace(/\r\n?/g, '\n').trim()
  return subject ? `${l.subject}: ${subject}\n\n${body}` : body
}

/**
 * Full session export: title, date/duration/mode line, notes, action items (checkboxes),
 * follow-up email and the transcript (`**Me** [mm:ss]: …`). Empty sections are omitted.
 */
export function sessionMarkdown(detail: SessionDetail, opts: MarkdownOptions = {}): string {
  const l = labelsFrom(opts)
  const parts: string[] = []
  const title = inline(detail.title) || inline(detail.notes?.title ?? '') || l.untitled
  parts.push(`# ${title}`)

  const meta = [`**${l.date}:** ${formatDateTime(detail.startedAt)}`]
  const duration =
    detail.durationMs ?? (detail.endedAt != null ? detail.endedAt - detail.startedAt : null)
  if (duration != null && duration >= 0) meta.push(`**${l.duration}:** ${formatDuration(duration)}`)
  if (detail.modeName?.trim()) meta.push(`**${l.mode}:** ${inline(detail.modeName)}`)
  parts.push(meta.join(' · '))

  if (detail.notes) {
    const notes = renderNotesMarkdown(detail.notes, opts)
    if (notes) parts.push(notes)
  }

  const actions = renderActionItemsMarkdown(detail.actionItems)
  if (actions) parts.push(`## ${l.actionItems}\n${actions}`)

  if (detail.email && (detail.email.subject.trim() || detail.email.body.trim())) {
    const subject = inline(detail.email.subject)
    const body = detail.email.body.replace(/\r\n?/g, '\n').trim()
    const lines = [`## ${l.followUpEmail}`]
    if (subject) lines.push(`**${l.subject}:** ${subject}`)
    parts.push([lines.join('\n'), body].filter((s) => s.length > 0).join('\n\n'))
  }

  const blocks = mergeTranscriptLines(usableLines(detail.transcript))
  if (blocks.length) {
    const speaker = { me: l.me, them: l.them }
    const body = blocks
      .map((b) => `**${speaker[b.channel]}** [${formatTimestamp(b.startMs)}]: ${b.text}`)
      .join('\n\n')
    parts.push(`## ${l.transcript}\n\n${body}`)
  }

  return `${parts.join('\n\n')}\n`
}
