/** Strings for the first-run onboarding. All user-facing text goes through t(). */
export const onboarding = {
  welcome: 'Welcome to Bluely',
  intro: 'Three quick steps and you’re ready for your next call.',
  progressLabel: 'Setup progress',
  stepOf: 'Step {n} of {total}',
  steps: {
    key: 'Connect AI',
    audio: 'Check audio',
    mode: 'Pick a Mode',
  },
  key: {
    title: 'Connect your OpenRouter key',
    body: 'Bluely runs on your own OpenRouter account, so you choose the models and pay only for what you use. There is no Bluely account or server.',
    testFirst: 'Test the connection to continue, or skip and add a key later in Settings.',
    ready: 'All set. Your key works.',
  },
  audio: {
    title: 'Check your audio',
    body: 'Bluely listens to your microphone (“Me”) and your computer’s sound (“Them”). Give both a quick test.',
    askTitle: 'Ask shortcut',
    askBody:
      '{keys} is Bluely’s Ask shortcut. If your chat apps use Ctrl+Enter to send, switch Ask to Alt+Enter.',
    askApply: 'Use Alt+Enter',
    askApplied: 'Ask is now Alt+Enter',
    askBodyApplied: 'Ask uses Alt+Enter, so it won’t clash with Ctrl+Enter “send” in chat apps.',
  },
  mode: {
    title: 'Pick a Mode',
    body: 'A Mode tells Bluely what kind of call this is. You can edit Modes or create your own anytime.',
    filesTitle: 'Add files for “{mode}”',
    filesOptional:
      'Optional. Product sheets, pricing, your CV or notes help Bluely answer with facts.',
    nameTitle: 'Your name',
    nameOptional: 'Optional. Used so suggestions sound like you.',
    namePlaceholder: 'e.g. Nadia Rahman',
    loadError: 'Could not load Modes: {error}',
  },
  finish: 'Finish setup',
  start: 'Start Bluely',
  skip: 'Skip for now',
  startFailed: 'Bluely could not start a session: {error}',
} as const
