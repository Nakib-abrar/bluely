/** Section labels and post-call errors for exported Markdown (main process). */
export const exportLabels = {
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
  postCall: {
    noTranscript: 'No transcript was recorded for this session.',
    invalidResponse:
      'The model’s reply could not be read. Try regenerating, or pick another Notes model in Settings › AI Models.',
    emptyResponse:
      'The model returned an empty reply. Try regenerating, or pick another Notes model in Settings › AI Models.',
    longTranscriptFailed: 'Could not summarize this long transcript.',
  },
} as const
