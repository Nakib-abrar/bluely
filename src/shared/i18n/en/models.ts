/** Model catalog, validation and latency-test messages (main process). */
export const models = {
  roleFast: 'Fast',
  roleSmart: 'Smart',
  roleNotes: 'Notes',
  roleStt: 'Speech-to-text',
  defaultUnavailable:
    'Default model {requested} is not available on OpenRouter right now; using {resolved}.',
  unavailable:
    'The {role} model {requested} is not available on OpenRouter right now; using {resolved}.',
  noVision:
    'The Smart model {requested} cannot read images, which screen questions need; using {resolved}.',
  notStt: '{requested} is not a speech-to-text model; using {resolved} for transcription.',
  incompatible: '{requested} cannot be used as the {role} model; using {resolved}.',
  noReplacement:
    'The {role} model {requested} is not available on OpenRouter right now and no replacement was found. Pick another model in Settings › AI Models.',
  incompatibleNoReplacement:
    '{requested} cannot be used as the {role} model and no replacement was found. Pick another model in Settings › AI Models.',
  latencyBusy: 'A latency test is already running.',
  latencyCancelled: 'Latency test cancelled.',
  latencyNoModels: 'Pick at least one model to test.',
  answerEmpty:
    'The model returned an empty answer. Try again, or pick another model in Settings › AI Models.',
  answerBudgetUsed:
    'The model used its whole token limit before answering (reasoning models think first). Try again, or pick another model in Settings › AI Models.',
  answerTruncated: 'Cut off: the answer reached its length limit.',
  latencyNoAnswer:
    'The model returned no answer text within the token limit (reasoning models can use it all up).',
} as const
