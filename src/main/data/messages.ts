/**
 * User-facing strings of the history/data slice (Markdown export, mail drafts, dialogs, errors).
 *
 * The slice does not own an i18n namespace yet, so these live here in the exact shape of an
 * i18n namespace file. Moving them to `src/shared/i18n/en/history.ts` only requires replacing
 * `ht('key')` with `t('history.key')`.
 */
export const history = {
  untitled: 'Untitled meeting',

  mdDuration: 'Duration {duration}',
  mdMode: 'Mode: {mode}',
  mdSummary: 'Summary',
  mdKeyPoints: 'Key points',
  mdDecisions: 'Decisions',
  mdActionItems: 'Action items',
  mdFollowUpEmail: 'Follow-up email',
  mdSubject: 'Subject:',
  mdTranscript: 'Transcript',

  mailTruncated: '[Truncated: copy the full email from Bluely]',

  dialogExportMarkdown: 'Export meeting as Markdown',
  dialogExportAll: 'Export all Bluely data',
  filterMarkdown: 'Markdown',
  filterZip: 'ZIP archive',

  errSessionNotFound: 'That meeting no longer exists.',
  errActionItemNotFound: 'That action item no longer exists.',
  errEmptyActionItem: 'Action item text cannot be empty.',
  errNoEmail: 'This meeting does not have a follow-up email yet.',
  errMailBlocked: 'Could not open your mail app.',
  errSessionLive: 'Stop the live session first.',
  errDeleteAllWhileLive: 'Stop the live session before deleting all data.',
} as const

export type HistoryMessageKey = keyof typeof history

/** Same contract as the shared `t()`: `{name}` placeholders are replaced from `vars`. */
export function ht(key: HistoryMessageKey, vars?: Record<string, string | number>): string {
  const raw: string = history[key]
  if (!vars) return raw
  return raw.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m))
}
