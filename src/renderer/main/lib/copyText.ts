import { t } from '@shared/i18n'
import type { FollowUpEmail, MeetingNotes, TranscriptLine } from '@shared/types'

/** "[03:07]" (or "[1:02:03]") from milliseconds since the session started. */
export function transcriptStamp(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h > 0
    ? `[${h}:${String(m).padStart(2, '0')}:${s}]`
    : `[${String(m).padStart(2, '0')}:${s}]`
}

/** Notes as Markdown for the clipboard. */
export function notesToMarkdown(title: string, notes: MeetingNotes): string {
  const out = [`# ${title}`, '']
  if (notes.summary.trim()) out.push(notes.summary.trim(), '')
  if (notes.keyPoints.length) {
    out.push(`## ${t('session.notes.keyPoints')}`, ...notes.keyPoints.map((p) => `- ${p}`), '')
  }
  if (notes.decisions.length) {
    out.push(`## ${t('session.notes.decisions')}`, ...notes.decisions.map((d) => `- ${d}`), '')
  }
  return out.join('\n').trim()
}

/** Plain transcript, one "[mm:ss] Me: text" line per utterance. */
export function transcriptToText(lines: readonly TranscriptLine[]): string {
  return lines
    .map(
      (l) =>
        `${transcriptStamp(l.startMs)} ${l.channel === 'me' ? t('common.me') : t('common.them')}: ${l.text}`,
    )
    .join('\n')
}

/** Subject + body, as pasted into a mail client. */
export function emailToText(email: FollowUpEmail): string {
  const subject = email.subject.trim()
  return subject ? `${t('session.email.subject')}: ${subject}\n\n${email.body}` : email.body
}
