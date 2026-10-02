/**
 * Release notes shown in Settings › Release notes. This is versioned content (like a changelog),
 * not UI chrome, so it is kept as plain data here rather than in the i18n catalog.
 */
export interface ReleaseNote {
  version: string
  /** ISO date (YYYY-MM-DD). */
  date: string
  title: string
  highlights: { title: string; body: string }[]
}

export const RELEASE_NOTES: readonly ReleaseNote[] = [
  {
    version: '0.1.0',
    date: '2026-10-02',
    title: 'Hello, Bluely',
    highlights: [
      {
        title: 'Live transcript of both sides',
        body: 'Your microphone ("Me") and your computer’s audio ("Them") are transcribed as you talk, in Zoom, Meet, Teams or anything else that plays audio.',
      },
      {
        title: 'Suggestions when someone asks you something',
        body: 'Bluely notices questions and suggests what to say next, follow-up questions, fact checks and recaps in a small overlay that stays on top.',
      },
      {
        title: 'Notes, action items and a follow-up email',
        body: 'After the call Bluely writes notes, action items and a draft email, saved in a searchable history on your PC.',
      },
      {
        title: 'Modes with your own files',
        body: 'Pick a Mode such as Sales call or Client discovery, tweak its instructions and add PDFs, DOCX, TXT or Markdown files it can quote from.',
      },
      {
        title: 'Bring your own OpenRouter key',
        body: 'Choose the models for each job, see latency and costs, and pay OpenRouter directly. No Bluely account, no server, no telemetry.',
      },
      {
        title: 'Keyboard first',
        body: 'Global shortcuts for Ask, actions and moving the overlay, with conflict detection and an Alt+Enter preset for Ask.',
      },
    ],
  },
]
