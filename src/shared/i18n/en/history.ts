/** History, export, mail draft and data-management messages (main process). */
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
