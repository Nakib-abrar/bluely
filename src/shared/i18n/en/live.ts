/** Strings produced by the main process for live sessions, notices and post-call output. */
export const live = {
  untitledMeeting: 'Meeting on {date}',
  emptySession: 'Empty session',
  noTranscript: 'Nothing was transcribed in this session.',
  screenUnavailable: 'Could not capture the screen; answered without it.',
  notices: {
    noKeyTitle: 'Add your OpenRouter API key',
    noKeyBody: 'Bluely needs a key to transcribe calls and suggest replies.',
    noKeyAction: 'Open AI Models',
    modelFallbackTitle: 'A default model was replaced',
    modelAction: 'Review models',
    recoveredTitle: 'Recovered an unfinished session',
    recoveredBody: '“{title}” from {date} ended unexpectedly. Its transcript was saved.',
    recoveredAction: 'Generate notes',
    updateAvailableTitle: 'Bluely {version} is available',
    updateAvailableAction: 'Open updates',
    updateReadyTitle: 'Update ready: Bluely {version}',
    updateReadyBody: 'Restart Bluely to finish updating.',
    updateReadyAction: 'Restart to update',
    postCallFailedTitle: 'Notes could not be generated',
    postCallFailedAction: 'Open session',
  },
} as const
