import { t } from '@shared/i18n'

/*
 * User-facing strings produced by the ai slice (Markdown export and post-call errors).
 *
 * The ai slice owns no i18n namespace yet, so strings without an existing key live here in
 * English and every renderer accepts overrides. Once keys exist (see the slice report's contract
 * requests), these defaults should switch to t().
 */

/** Section labels for exported Markdown. */
export interface MarkdownLabels {
  untitled: string
  date: string
  duration: string
  mode: string
  summary: string
  keyPoints: string
  decisions: string
  actionItems: string
  followUpEmail: string
  subject: string
  transcript: string
  me: string
  them: string
}

export function defaultMarkdownLabels(): MarkdownLabels {
  return {
    untitled: 'Untitled meeting',
    date: 'Date',
    duration: 'Duration',
    mode: 'Mode',
    summary: 'Summary',
    keyPoints: 'Key points',
    decisions: 'Decisions',
    actionItems: 'Action items',
    followUpEmail: 'Follow-up email',
    subject: 'Subject',
    transcript: 'Transcript',
    me: t('common.me'),
    them: t('common.them'),
  }
}

/** Post-call error messages (stored as the session's postCallError and shown in the UI). */
export const POST_CALL_MESSAGES = {
  noTranscript: 'No transcript was recorded for this session.',
  invalidResponse:
    'The model’s reply could not be read. Try regenerating, or pick another Notes model in Settings › AI Models.',
  emptyResponse:
    'The model returned an empty reply. Try regenerating, or pick another Notes model in Settings › AI Models.',
  longTranscriptFailed: 'Could not summarize this long transcript.',
} as const
