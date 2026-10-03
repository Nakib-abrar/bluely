export const APP_NAME = 'Bluely'
export const REPO_OWNER = 'nakib-abrar'
export const REPO_NAME = 'bluely'
export const REPO_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}`
export const ISSUES_URL = `${REPO_URL}/issues/new/choose`
export const RELEASES_URL = `${REPO_URL}/releases`
export const DOCS_URL = `${REPO_URL}#readme`

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'
export const OPENROUTER_KEYS_URL = 'https://openrouter.ai/keys'
export const OPENROUTER_CREDITS_URL = 'https://openrouter.ai/settings/credits'

/** Sent as HTTP-Referer / X-Title for OpenRouter app attribution. */
export const ATTRIBUTION_REFERER = REPO_URL
export const ATTRIBUTION_TITLE = APP_NAME

/**
 * What renderer-reachable shell.openExternal calls may open, checked on the parsed URL (never a
 * string prefix): https only, any page on `hosts`, and on `repo.host` only `repo.path` and the
 * pages below it. mailto: is deliberately absent: the follow-up email draft is opened by main
 * from a URL it built itself.
 */
export const EXTERNAL_URL_ALLOWLIST = {
  hosts: ['openrouter.ai'],
  repo: { host: 'github.com', path: `/${REPO_OWNER}/${REPO_NAME}` },
} as const

/** Folder under screenshotsDir for screenshots taken while no session was recording. */
export const SCREENSHOTS_NO_SESSION_DIR = 'no-session'

export const CONSENT_DISCLOSURE_MESSAGE =
  "Heads up: I'm using an AI note-taker (Bluely) to transcribe this call."

/** Search snippet highlight markers (control characters never typed by users). */
export const SNIPPET_MARK_START = '\u0002'
export const SNIPPET_MARK_END = '\u0003'

export const KNOWLEDGE_LIMITS = {
  maxFileBytes: 20 * 1024 * 1024,
  maxFilesPerMode: 50,
  chunkTokens: 800,
  chunkOverlapTokens: 100,
  extensions: ['.pdf', '.docx', '.txt', '.md'] as const,
}

export const AUDIO = {
  sampleRate: 16_000,
  /** Silero v5 frame size at 16 kHz (32 ms). */
  frameSamples: 512,
  /** Show "No system audio detected" after this much Them-silence while Me is speaking. */
  noSystemAudioAfterMs: 20_000,
  /** Me-line echo de-duplication window and threshold. */
  dedupWindowMs: 3_000,
  dedupSimilarity: 0.8,
}

export const OVERLAY = {
  panelWidth: 520,
  windowWidth: 560,
  collapsedHeight: 64,
  maxExpandedHeight: 640,
  moveStepPx: 10,
  moveStepLargePx: 50,
  hideForCaptureMs: 120,
}

export const SCREEN_CAPTURE = {
  maxWidth: 1600,
  jpegQuality: 80,
}
