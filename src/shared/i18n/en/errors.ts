/** Friendly provider error messages (used by the main process too). */
export const errors = {
  no_key: 'Add your OpenRouter API key in Settings › AI Models to use Bluely.',
  auth: 'OpenRouter rejected the API key. Check it in Settings › AI Models.',
  credits: 'Your OpenRouter account is out of credits. Top up at openrouter.ai to continue.',
  // Shown after Bluely's own automatic retry has also been rate limited.
  rate_limit: 'OpenRouter is rate limiting requests. Wait a moment, then try again.',
  server: 'The model provider had a problem. Try again in a moment.',
  timeout: 'The request timed out. Check your connection and try again.',
  network: 'Could not reach OpenRouter. Check your internet connection.',
  bad_request: 'The request was rejected by the model. Try another model in Settings.',
  moderation: 'The provider flagged this request and refused to answer.',
  aborted: 'Cancelled.',
  model_unavailable:
    'That model is not available right now. Pick another one in Settings › AI Models.',
  unknown: 'Something went wrong. Try again.',
  invalid_audio: 'That audio could not be read. Try recording again.',
} as const
