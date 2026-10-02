/**
 * User-facing strings produced by the models feature in the main process.
 *
 * They are kept here (English, `{placeholder}` syntax identical to `t()`) because this slice does
 * not own an i18n namespace. Moving them into `src/shared/i18n/en/*` is a drop-in change:
 * replace `modelMessage(key, vars)` with `t('models.<key>', vars)`.
 */
export const MODEL_MESSAGES = {
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
} as const

export type ModelMessageKey = keyof typeof MODEL_MESSAGES

export function modelMessage(key: ModelMessageKey, vars?: Record<string, string | number>): string {
  const raw: string = MODEL_MESSAGES[key]
  if (!vars) return raw
  return raw.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m))
}
