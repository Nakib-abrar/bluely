/**
 * The single typed IPC contract between main and renderers.
 *
 * - `invoke` channels: renderer → main request/response. Every request payload has a zod
 *   schema that main validates before the handler runs (see src/main/ipc/registry.ts).
 * - `events`: main → renderer push messages.
 *
 * Responses travel in an envelope ({ ok, data } | { ok: false, error }) so renderers get
 * typed errors instead of Electron's stringified exceptions.
 */
import { z } from 'zod'
import type {
  ActionItem,
  AiCard,
  AiErrorInfo,
  AppInfo,
  ChannelStatus,
  KeybindStatus,
  KeyStatus,
  KeyTestResult,
  KnowledgeFile,
  LatencyTestProgress,
  LatencyTrace,
  LiveSessionState,
  MainWindowRoute,
  Mode,
  ModelInfo,
  ModelStat,
  ModelValidationResult,
  MonthSpend,
  Notice,
  OverlayCommand,
  SearchResult,
  SessionDetail,
  SessionSummary,
  SpeedStats,
  TranscriptLine,
  UpdateStatus,
  SettingsPage,
} from './types'
import type { Settings } from './settings'

// ───────────────────────────── helpers ─────────────────────────────

interface InvokeDef<Req extends z.ZodType, Res> {
  req: Req
  /** Phantom field carrying the response type. Never read at runtime. */
  res: Res
}

function ch<Req extends z.ZodType>(req: Req) {
  return {
    returns<Res>(): InvokeDef<Req, Res> {
      return { req, res: undefined as unknown as Res }
    },
  }
}

const none = z.undefined()
const id = z.string().min(1).max(128)
const uint8 = z.custom<Uint8Array>((v) => v instanceof Uint8Array, 'Expected Uint8Array')

export const channelSchema = z.enum(['me', 'them'])
export const actionKindSchema = z.enum(['assist', 'say', 'followups', 'factcheck', 'who', 'recap'])
export const settingsPageSchema = z.enum([
  'general',
  'models',
  'modes',
  'keybinds',
  'profile',
  'language',
  'privacy',
  'releaseNotes',
  'help',
])

export const mainWindowRouteSchema = z.discriminatedUnion('name', [
  z.object({ name: z.literal('home') }),
  z.object({ name: z.literal('onboarding') }),
  z.object({
    name: z.literal('session'),
    sessionId: z.string().min(1).max(128),
    tab: z.enum(['notes', 'actions', 'transcript', 'email', 'chat']).optional(),
  }),
])

export const modeInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  icon: z.string().max(16),
  instructions: z.string().max(8000),
  tone: z.enum(['concise', 'friendly', 'formal']),
  autoSuggest: z.boolean(),
  modelOverrides: z.object({
    fast: z.string().max(200).optional(),
    smart: z.string().max(200).optional(),
    notes: z.string().max(200).optional(),
  }),
})

// ───────────────────────────── invoke channels ─────────────────────────────

export const invokeContract = {
  // App & windows
  'app:getInfo': ch(none).returns<AppInfo>(),
  'app:getNotices': ch(none).returns<Notice[]>(),
  'app:dismissNotice': ch(z.object({ id: z.string().max(200) })).returns<void>(),
  'app:openExternal': ch(z.object({ url: z.string().url().max(2000) })).returns<boolean>(),
  'app:openMainWindow': ch(z.object({ route: mainWindowRouteSchema.optional() })).returns<void>(),
  'app:openSettings': ch(z.object({ page: settingsPageSchema.optional() })).returns<void>(),
  'app:openDataFolder': ch(none).returns<void>(),
  'app:quit': ch(none).returns<void>(),
  'app:rendererLog': ch(
    z.object({ level: z.enum(['debug', 'info', 'warn', 'error']), message: z.string().max(4000) }),
  ).returns<void>(),
  'clipboard:writeText': ch(z.object({ text: z.string().max(1_000_000) })).returns<void>(),

  'window:minimize': ch(none).returns<void>(),
  'window:toggleMaximize': ch(none).returns<boolean>(),
  'window:close': ch(none).returns<void>(),
  'window:isMaximized': ch(none).returns<boolean>(),

  // Settings & secrets
  'settings:get': ch(none).returns<Settings>(),
  /** Deep-partial patch; main merges it and validates the full result. */
  'settings:update': ch(z.object({ patch: z.record(z.string(), z.unknown()) })).returns<Settings>(),
  'settings:reset': ch(
    z.object({ section: z.enum(['keybinds', 'advanced', 'all']) }),
  ).returns<Settings>(),
  'key:getStatus': ch(none).returns<KeyStatus>(),
  'key:set': ch(z.object({ key: z.string().trim().min(10).max(400) })).returns<KeyStatus>(),
  'key:clear': ch(none).returns<KeyStatus>(),
  'key:test': ch(none).returns<KeyTestResult>(),

  // Models
  'models:list': ch(z.object({ refresh: z.boolean().optional() })).returns<ModelInfo[]>(),
  'models:validateDefaults': ch(none).returns<ModelValidationResult[]>(),
  'models:runLatencyTest': ch(
    z.object({
      models: z.array(z.string().min(1).max(200)).min(1).max(8),
      runs: z.number().int().min(1).max(10).optional(),
    }),
  ).returns<{ runId: string }>(),
  'models:getStats': ch(none).returns<ModelStat[]>(),
  'usage:getMonthSpend': ch(none).returns<MonthSpend>(),

  // Live session
  'session:start': ch(z.object({ modeId: id.optional() })).returns<{ sessionId: string }>(),
  'session:stop': ch(none).returns<void>(),
  'session:getState': ch(none).returns<LiveSessionState>(),
  'session:getTranscript': ch(z.object({ sessionId: id })).returns<TranscriptLine[]>(),
  'session:dismissConsent': ch(none).returns<void>(),
  'session:setAutoSuggest': ch(z.object({ enabled: z.boolean() })).returns<void>(),

  // Audio (renderer capture → main)
  'audio:segment': ch(
    z.object({
      sessionId: id,
      channel: channelSchema,
      /** Epoch ms of the first sample in the segment. */
      startedAt: z.number(),
      endedAt: z.number(),
      /** Epoch ms when VAD reported the end of speech (latency tracing). */
      vadEndAt: z.number(),
      /** True when the segment was cut by the max-length cap rather than a pause. */
      forced: z.boolean(),
      /** 16 kHz mono 16-bit PCM WAV. */
      wav: uint8.refine(
        (b) => b.byteLength > 44 && b.byteLength <= 4 * 1024 * 1024,
        'WAV size out of range',
      ),
    }),
  ).returns<{ accepted: boolean }>(),
  'audio:channelStatus': ch(
    z.object({
      sessionId: id,
      channel: channelSchema,
      state: z.enum(['off', 'starting', 'listening', 'error']),
      error: z.string().max(500).nullable(),
    }),
  ).returns<void>(),
  'audio:warning': ch(
    z.object({
      sessionId: id,
      code: z.enum([
        'no_system_audio',
        'mic_muted',
        'mic_not_found',
        'loopback_unavailable',
        'use_headphones',
      ]),
      active: z.boolean(),
    }),
  ).returns<void>(),
  /** Live VAD state of a channel (lets auto-suggest wait while the other person keeps talking). */
  'audio:speaking': ch(
    z.object({ sessionId: id, channel: channelSchema, speaking: z.boolean() }),
  ).returns<void>(),
  /** Overlay finished flushing audio after a stop request. */
  'audio:stopped': ch(z.object({ sessionId: id })).returns<void>(),
  /** Settings › Test microphone: transcribe a short sample with the configured STT model. */
  'audio:testTranscribe': ch(z.object({ wav: uint8 })).returns<{
    text: string
    latencyMs: number
    model: string
  }>(),

  // Live AI
  'ai:run': ch(
    z.object({
      kind: z.union([actionKindSchema, z.literal('ask')]),
      question: z.string().max(4000).optional(),
      includeScreen: z.boolean().optional(),
      tier: z.enum(['fast', 'smart']).optional(),
    }),
  ).returns<{ id: string }>(),
  'ai:cancel': ch(z.object({ id })).returns<void>(),
  'ai:clear': ch(none).returns<void>(),
  'ai:getCards': ch(
    z.object({ scope: z.enum(['live', 'meeting_chat', 'search']), sessionId: id.optional() }),
  ).returns<AiCard[]>(),

  // Modes & knowledge
  'modes:list': ch(none).returns<Mode[]>(),
  'modes:create': ch(modeInputSchema).returns<Mode>(),
  'modes:update': ch(z.object({ id, patch: modeInputSchema.partial() })).returns<Mode>(),
  'modes:delete': ch(z.object({ id })).returns<void>(),
  'modes:resetBuiltin': ch(z.object({ id })).returns<Mode>(),
  'modes:setActive': ch(z.object({ id })).returns<void>(),
  'knowledge:list': ch(z.object({ modeId: id })).returns<KnowledgeFile[]>(),
  /** Opens a native file picker in main and ingests the chosen files. */
  'knowledge:pickAndAdd': ch(z.object({ modeId: id })).returns<KnowledgeFile[]>(),
  /** Drag & drop: paths come from webUtils.getPathForFile in preload. */
  'knowledge:addPaths': ch(
    z.object({ modeId: id, paths: z.array(z.string().min(1).max(2000)).min(1).max(50) }),
  ).returns<KnowledgeFile[]>(),
  'knowledge:delete': ch(z.object({ fileId: id })).returns<void>(),

  // History
  'sessions:list': ch(
    z.object({ limit: z.number().int().min(1).max(500).optional(), before: z.number().optional() }),
  ).returns<SessionSummary[]>(),
  'sessions:get': ch(z.object({ id })).returns<SessionDetail | null>(),
  'sessions:rename': ch(z.object({ id, title: z.string().trim().min(1).max(200) })).returns<void>(),
  'sessions:delete': ch(z.object({ id })).returns<void>(),
  'sessions:regenerate': ch(z.object({ id })).returns<void>(),
  'sessions:updateEmail': ch(
    z.object({ id, subject: z.string().max(500), body: z.string().max(50_000) }),
  ).returns<void>(),
  'sessions:exportMarkdown': ch(z.object({ id, target: z.enum(['file', 'clipboard']) })).returns<{
    path: string | null
  }>(),
  'sessions:openMailDraft': ch(z.object({ id })).returns<void>(),
  'sessions:chat': ch(z.object({ id, question: z.string().trim().min(1).max(4000) })).returns<{
    id: string
  }>(),
  'actionItems:setDone': ch(z.object({ id, done: z.boolean() })).returns<ActionItem>(),

  // Search
  'search:query': ch(
    z.object({ query: z.string().max(500), limit: z.number().int().min(1).max(200).optional() }),
  ).returns<SearchResult>(),
  'search:ask': ch(z.object({ question: z.string().trim().min(1).max(2000) })).returns<{
    id: string
  }>(),

  // Data
  'data:exportAll': ch(none).returns<{ path: string | null }>(),
  'data:deleteAll': ch(z.object({ confirm: z.literal('DELETE') })).returns<void>(),

  // Overlay window
  'overlay:toggle': ch(none).returns<boolean>(),
  'overlay:setVisible': ch(z.object({ visible: z.boolean() })).returns<void>(),
  'overlay:setExpanded': ch(z.object({ expanded: z.boolean() })).returns<void>(),
  'overlay:setContentSize': ch(
    z.object({
      width: z.number().int().min(100).max(1200),
      height: z.number().int().min(40).max(1400),
    }),
  ).returns<void>(),
  'overlay:setIgnoreMouse': ch(z.object({ ignore: z.boolean() })).returns<void>(),
  'overlay:focus': ch(none).returns<void>(),

  // Keybinds & updates
  'keybinds:getStatus': ch(none).returns<KeybindStatus[]>(),
  /** Settings is recording a new shortcut: release Bluely's global shortcuts meanwhile. */
  'keybinds:setCapturing': ch(z.object({ active: z.boolean() })).returns<void>(),
  'updater:check': ch(none).returns<UpdateStatus>(),
  'updater:download': ch(none).returns<void>(),
  'updater:install': ch(none).returns<void>(),
  'updater:getStatus': ch(none).returns<UpdateStatus>(),
} as const

export type InvokeContract = typeof invokeContract
export type InvokeChannel = keyof InvokeContract
export type InvokeRequest<C extends InvokeChannel> = z.input<InvokeContract[C]['req']>
export type InvokeRequestParsed<C extends InvokeChannel> = z.output<InvokeContract[C]['req']>
export type InvokeResponse<C extends InvokeChannel> = InvokeContract[C]['res']

export interface IpcErrorPayload {
  code: string
  message: string
  /** Present when the error came from an AI provider. */
  ai?: AiErrorInfo
}

export type IpcEnvelope<T> = { ok: true; data: T } | { ok: false; error: IpcErrorPayload }

// ───────────────────────────── events (main → renderer) ─────────────────────────────

export interface EventContract {
  'settings:changed': Settings
  /** The OpenRouter key was saved or removed. */
  'key:changed': KeyStatus
  'session:state': LiveSessionState
  /** Upsert by id (partial → final updates arrive with the same id). */
  'transcript:line': TranscriptLine
  'transcript:remove': { id: string; sessionId: string }
  'ai:card': AiCard
  'ai:delta': { id: string; delta: string }
  'ai:done': { id: string; text: string; stats: SpeedStats }
  'ai:error': { id: string; error: AiErrorInfo }
  'ai:cancelled': { id: string }
  /** Refined stats from GET /generation after the stream finished. */
  'ai:stats': { id: string; stats: SpeedStats }
  'ai:cleared': { scope: 'live' }
  'models:latencyProgress': LatencyTestProgress
  'knowledge:changed': { modeId: string; files: KnowledgeFile[] }
  'modes:changed': Mode[]
  'sessions:changed': { id: string | null }
  'app:notices': Notice[]
  'updater:status': UpdateStatus
  'keybinds:status': KeybindStatus[]
  'overlay:command': OverlayCommand
  'overlay:visibility': { visible: boolean; expanded: boolean }
  'window:maximized': boolean
  navigate: MainWindowRoute
  'settings:open': { page: SettingsPage | null }
  'dev:latency': LatencyTrace
  'audio:channelStatus': { channel: 'me' | 'them'; status: ChannelStatus }
}

export type EventChannel = keyof EventContract
export type EventPayload<E extends EventChannel> = EventContract[E]

/** Channel name lists used by preload to allowlist IPC. */
export const INVOKE_CHANNELS = Object.keys(invokeContract) as InvokeChannel[]
export const EVENT_CHANNELS: EventChannel[] = [
  'settings:changed',
  'key:changed',
  'session:state',
  'transcript:line',
  'transcript:remove',
  'ai:card',
  'ai:delta',
  'ai:done',
  'ai:error',
  'ai:cancelled',
  'ai:stats',
  'ai:cleared',
  'models:latencyProgress',
  'knowledge:changed',
  'modes:changed',
  'sessions:changed',
  'app:notices',
  'updater:status',
  'keybinds:status',
  'overlay:command',
  'overlay:visibility',
  'window:maximized',
  'navigate',
  'settings:open',
  'dev:latency',
  'audio:channelStatus',
]
