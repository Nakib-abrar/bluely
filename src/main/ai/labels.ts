import { t } from '@shared/i18n'
import { exportLabels } from '@shared/i18n/en/exportLabels'

/* User-facing strings for Markdown export and post-call errors. Source: src/shared/i18n/en/exportLabels.ts. */

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
    untitled: t('exportLabels.untitled'),
    date: t('exportLabels.date'),
    duration: t('exportLabels.duration'),
    mode: t('exportLabels.mode'),
    summary: t('exportLabels.summary'),
    keyPoints: t('exportLabels.keyPoints'),
    decisions: t('exportLabels.decisions'),
    actionItems: t('exportLabels.actionItems'),
    followUpEmail: t('exportLabels.followUpEmail'),
    subject: t('exportLabels.subject'),
    transcript: t('exportLabels.transcript'),
    me: t('common.me'),
    them: t('common.them'),
  }
}

/** Post-call error messages (stored as the session's postCallError and shown in the UI). */
export const POST_CALL_MESSAGES = exportLabels.postCall
