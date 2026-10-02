/**
 * Domain types shared by the main process, preload and both renderers.
 * Keep this file free of runtime code (types only) so it can be imported anywhere.
 */

export type Channel = 'me' | 'them'
export type Tier = 'fast' | 'smart'
export type ModelRole = 'fast' | 'smart' | 'notes'
export type Tone = 'concise' | 'friendly' | 'formal'
export type ThemePreference = 'system' | 'light' | 'dark'

// ───────────────────────────── Transcript ─────────────────────────────

export interface TranscriptLine {
  id: string
  sessionId: string
  channel: Channel
  /** Milliseconds since the session started. */
  startMs: number
  endMs: number
  text: string
  /** false while a streaming provider is still revising the line (partial → final). */
  isFinal: boolean
}

// ───────────────────────────── Sessions ─────────────────────────────

export type SessionStatus = 'active' | 'processing' | 'done' | 'recovered' | 'failed'

export interface SessionSummary {
  id: string
  title: string
  modeId: string | null
  startedAt: number
  endedAt: number | null
  durationMs: number | null
  status: SessionStatus
}

export interface MeetingNotes {
  title: string
  summary: string
  keyPoints: string[]
  decisions: string[]
}

export interface FollowUpEmail {
  subject: string
  body: string
}

export interface ActionItem {
  id: string
  sessionId: string
  text: string
  owner: string | null
  due: string | null
  done: boolean
}

/** Shape stored in sessions.summary_json. */
export interface SessionSummaryJson {
  notes: MeetingNotes | null
  email: FollowUpEmail | null
  /** Rolling summary of older transcript, updated during the call. */
  runningSummary: string | null
  postCallError: string | null
}

export interface SessionDetail extends SessionSummary {
  notes: MeetingNotes | null
  email: FollowUpEmail | null
  actionItems: ActionItem[]
  transcript: TranscriptLine[]
  postCallError: string | null
  modeName: string | null
}

// ───────────────────────────── AI / providers ─────────────────────────────

export type ActionKind = 'assist' | 'say' | 'followups' | 'factcheck' | 'who' | 'recap'
export type LiveRequestKind = ActionKind | 'ask' | 'auto'

export type AiMessageKind =
  | LiveRequestKind
  | 'post_notes'
  | 'post_actions'
  | 'post_email'
  | 'meeting_chat'
  | 'search_ask'
  | 'summary'

export type ProviderErrorCode =
  | 'no_key'
  | 'auth'
  | 'credits'
  | 'rate_limit'
  | 'server'
  | 'timeout'
  | 'network'
  | 'bad_request'
  | 'moderation'
  | 'aborted'
  | 'model_unavailable'
  | 'unknown'

export interface AiErrorInfo {
  code: ProviderErrorCode
  /** Friendly, user-facing message. */
  message: string
  retryable: boolean
  /** Seconds to wait before retrying, when the provider told us. */
  retryAfterSec?: number | null
}

/** Numbers shown in the "⚡ 0.42 s to first word · 1.9 s total · 186 tok/s · groq · llama" line. */
export interface SpeedStats {
  ttftMs: number | null
  totalMs: number
  tokensPerSec: number | null
  tokensIn: number | null
  tokensOut: number | null
  costUsd: number | null
  provider: string | null
  model: string
  generationId: string | null
}

export type AiCardScope = 'live' | 'meeting_chat' | 'search'
export type AiCardStatus = 'streaming' | 'done' | 'error' | 'cancelled'

export interface Citation {
  sessionId: string
  title: string
  startedAt: number
}

/** One streamed answer. Rendered as a card in the overlay, meeting chat or search panel. */
export interface AiCard {
  id: string
  scope: AiCardScope
  sessionId: string | null
  kind: AiMessageKind
  /** Source label, e.g. "Auto · they asked a question", "Assist", or the user's own question. */
  label: string
  question: string | null
  usedScreen: boolean
  tier: Tier
  status: AiCardStatus
  text: string
  error: AiErrorInfo | null
  stats: SpeedStats | null
  citations: Citation[]
  createdAt: number
}

export interface ModelPricing {
  /** USD per token (OpenRouter returns strings; we parse to numbers). */
  prompt: number | null
  completion: number | null
  request: number | null
  image: number | null
  audio: number | null
}

export interface ModelInfo {
  id: string
  name: string
  contextLength: number | null
  pricing: ModelPricing
  inputModalities: string[]
  outputModalities: string[]
  supportsVision: boolean
  supportsAudioInput: boolean
  /** True for speech-to-text models usable with /audio/transcriptions. */
  isStt: boolean
  description: string | null
}

export type ProviderSort = 'latency' | 'price' | 'throughput'

export interface RoleConfig {
  model: string
  sort: ProviderSort
  /** Optional provider pinning, e.g. ["groq", "cerebras"]. */
  order: string[]
  allowFallbacks: boolean
}

export interface ModelValidationResult {
  role: ModelRole | 'stt'
  requested: string
  resolved: string
  replaced: boolean
  reason: string | null
}

export interface ModelStat {
  model: string
  provider: string | null
  samples: number
  ttftP50: number | null
  ttftP90: number | null
  totalP50: number | null
  tokensPerSecP50: number | null
  updatedAt: number
}

export interface LatencyTestProgress {
  runId: string
  model: string
  completed: number
  total: number
  /** Present when the model finished all its runs. */
  result: ModelStat | null
  errors: string[]
}

export interface KeyStatus {
  hasKey: boolean
  /** e.g. "sk-or-…9f3c". Never the full key. */
  masked: string | null
  encryptionAvailable: boolean
}

export interface KeyTestResult {
  ok: boolean
  label: string | null
  /** USD. null = unlimited / unknown. */
  limit: number | null
  usage: number | null
  remaining: number | null
  isFreeTier: boolean | null
  latencyMs: number | null
  error: AiErrorInfo | null
}

export interface MonthSpend {
  sinceMs: number
  totalUsd: number
  llmUsd: number
  sttUsd: number
  requests: number
}

// ───────────────────────────── Modes & knowledge ─────────────────────────────

export interface Mode {
  id: string
  name: string
  icon: string
  instructions: string
  tone: Tone
  autoSuggest: boolean
  modelOverrides: Partial<Record<ModelRole, string>>
  isBuiltin: boolean
  sort: number
}

export type KnowledgeFileStatus = 'pending' | 'parsing' | 'parsed' | 'failed'

export interface KnowledgeFile {
  id: string
  modeId: string
  filename: string
  size: number
  status: KnowledgeFileStatus
  error: string | null
  chunkCount: number
  addedAt: number
}

export interface KnowledgeSnippet {
  fileId: string
  filename: string
  chunkIdx: number
  text: string
  score: number
}

// ───────────────────────────── Live session ─────────────────────────────

export type LiveStatus = 'idle' | 'starting' | 'live' | 'stopping' | 'processing'

export type ChannelState = 'off' | 'starting' | 'listening' | 'error'

export interface ChannelStatus {
  state: ChannelState
  error: string | null
}

export type SessionWarningCode =
  | 'no_system_audio'
  | 'mic_muted'
  | 'mic_not_found'
  | 'loopback_unavailable'
  | 'stt_error_retrying'
  | 'use_headphones'
  | 'no_key'

export interface LiveSessionState {
  status: LiveStatus
  sessionId: string | null
  startedAt: number | null
  modeId: string
  audio: Record<Channel, ChannelStatus>
  warnings: SessionWarningCode[]
  autoSuggest: boolean
  /** Shown once per session when the consent reminder setting is on. */
  showConsentReminder: boolean
  lastError: string | null
}

/** Per-request latency breakdown for the dev overlay (Ctrl+Shift+D). Epoch milliseconds. */
export interface LatencyTrace {
  id: string
  kind: LiveRequestKind
  model: string
  vadEndAt: number | null
  sttDoneAt: number | null
  promptBuiltAt: number | null
  requestSentAt: number | null
  firstTokenAt: number | null
  doneAt: number | null
  promptTokensEstimate: number | null
}

// ───────────────────────────── Search ─────────────────────────────

export type SearchHitKind = 'title' | 'transcript' | 'notes' | 'action_item' | 'email'

/** Snippets mark matches with SNIPPET_MARK_START / SNIPPET_MARK_END (see constants). */
export interface SearchHit {
  sessionId: string
  kind: SearchHitKind
  refId: string | null
  snippet: string
  score: number
}

export interface SearchGroup {
  session: SessionSummary
  hits: SearchHit[]
}

export interface SearchResult {
  query: string
  looksLikeQuestion: boolean
  fuzzy: boolean
  groups: SearchGroup[]
}

// ───────────────────────────── App / misc ─────────────────────────────

export interface AppInfo {
  name: string
  version: string
  electron: string
  chrome: string
  platform: string
  arch: string
  isPackaged: boolean
  isPortable: boolean
  dataDir: string
  devMode: boolean
}

export type UpdateState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'
  | 'unsupported'

export interface UpdateStatus {
  state: UpdateState
  version: string | null
  progress: number | null
  error: string | null
  releaseUrl: string | null
}

export type NoticeKind = 'info' | 'warning' | 'success' | 'error'

export type NoticeAction =
  | { type: 'openSettings'; page: SettingsPage }
  | { type: 'openSession'; sessionId: string }
  | { type: 'regenerateSession'; sessionId: string }
  | { type: 'installUpdate' }
  | { type: 'openExternal'; url: string }

export interface Notice {
  id: string
  kind: NoticeKind
  title: string
  body: string | null
  action: { label: string; action: NoticeAction } | null
  dismissible: boolean
}

export type SettingsPage =
  | 'general'
  | 'models'
  | 'modes'
  | 'keybinds'
  | 'profile'
  | 'language'
  | 'privacy'
  | 'releaseNotes'
  | 'help'

export interface KeybindStatus {
  id: string
  accelerator: string | null
  registered: boolean
  /** e.g. "Taken by another app" */
  error: string | null
}

export type OverlayCommand =
  | { type: 'focusInput' }
  | { type: 'assist' }
  | { type: 'action'; action: ActionKind }
  | { type: 'clearChat' }
  | { type: 'scroll'; direction: 'up' | 'down' }
  | { type: 'toggleDevPanel' }
  | { type: 'setTab'; tab: 'insights' | 'transcript' }

export type MainWindowRoute =
  | { name: 'home' }
  | { name: 'session'; sessionId: string; tab?: SessionTab }
  | { name: 'onboarding' }

export type SessionTab = 'notes' | 'actions' | 'transcript' | 'email' | 'chat'
