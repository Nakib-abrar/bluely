import { z } from 'zod'
import defaultModels from './defaultModels.json'
import { DEFAULT_KEYBINDS, KEYBIND_IDS, type KeybindId } from './keybinds'
import { DEFAULT_MODE_ID } from './builtinModes'

const roleConfigSchema = z.object({
  model: z.string().min(1).max(200),
  sort: z.enum(['latency', 'price', 'throughput']),
  order: z.array(z.string().min(1).max(64)).max(10),
  allowFallbacks: z.boolean(),
})

const keybindsShape = Object.fromEntries(
  KEYBIND_IDS.map((id) => [id, z.string().max(64).nullable()]),
) as Record<KeybindId, z.ZodNullable<z.ZodString>>

export const settingsSchema = z.object({
  general: z.object({
    theme: z.enum(['system', 'light', 'dark']),
    launchAtStartup: z.boolean(),
    consentReminder: z.boolean(),
    autoSuggest: z.boolean(),
    /** When on, the overlay "Hide" button hides the whole widget instead of collapsing the panel. */
    hideHidesWidget: z.boolean(),
    onboardingComplete: z.boolean(),
    headphonesTipShown: z.boolean(),
    dismissedNotices: z.array(z.string().max(200)).max(200),
  }),
  audio: z.object({
    micDeviceId: z.string().max(500).nullable(),
    micLabel: z.string().max(500).nullable(),
  }),
  advanced: z.object({
    /** 0 = least sensitive, 1 = most sensitive. Maps to Silero thresholds. */
    vadSensitivity: z.number().min(0).max(1),
    maxSegmentSec: z.number().min(4).max(30),
    autoSuggestCooldownSec: z.number().min(0).max(120),
    autoSuggestDebounceMs: z.number().min(0).max(5000),
    contextMinutes: z.number().min(1).max(30),
    summaryIntervalMin: z.number().min(1).max(30),
    sttConcurrency: z.number().int().min(1).max(4),
    devLogging: z.boolean(),
  }),
  models: z.object({
    fast: roleConfigSchema,
    smart: roleConfigSchema,
    notes: roleConfigSchema,
    stt: z.object({ model: z.string().min(1).max(200) }),
    /** Tier used for typed questions and Assist; toggled by the overlay chip. */
    activeTier: z.enum(['fast', 'smart']),
  }),
  language: z.object({
    ui: z.enum(['en']),
    /** 'auto' or an ISO-639-1 code. */
    transcription: z.string().min(2).max(8),
    answer: z.enum(['conversation', 'en', 'bn']),
  }),
  privacy: z.object({
    /** 0 = keep forever. */
    retentionDays: z.union([z.literal(0), z.literal(30), z.literal(90), z.literal(365)]),
    saveScreenshots: z.boolean(),
  }),
  profile: z.object({
    name: z.string().max(200),
    role: z.string().max(200),
    company: z.string().max(200),
    about: z.string().max(4000),
  }),
  activeModeId: z.string().min(1).max(100),
  keybinds: z.object(keybindsShape),
  overlay: z.object({
    /** Last position per display id. */
    positions: z.record(z.string(), z.object({ x: z.number(), y: z.number() })),
    expanded: z.boolean(),
    tab: z.enum(['insights', 'transcript']),
  }),
})

export type Settings = z.infer<typeof settingsSchema>
export type RoleConfigSetting = z.infer<typeof roleConfigSchema>

function role(r: { model: string; sort: string; order: string[]; allowFallbacks: boolean }) {
  return {
    model: r.model,
    sort: r.sort as 'latency' | 'price' | 'throughput',
    order: [...r.order],
    allowFallbacks: r.allowFallbacks,
  }
}

export const DEFAULT_SETTINGS: Settings = {
  general: {
    theme: 'dark',
    launchAtStartup: false,
    consentReminder: true,
    autoSuggest: true,
    hideHidesWidget: false,
    onboardingComplete: false,
    headphonesTipShown: false,
    dismissedNotices: [],
  },
  audio: { micDeviceId: null, micLabel: null },
  advanced: {
    vadSensitivity: 0.5,
    maxSegmentSec: 12,
    autoSuggestCooldownSec: 8,
    autoSuggestDebounceMs: 700,
    contextMinutes: 6,
    summaryIntervalMin: 3,
    sttConcurrency: 2,
    devLogging: false,
  },
  models: {
    fast: role(defaultModels.fast),
    smart: role(defaultModels.smart),
    notes: role(defaultModels.notes),
    stt: { model: defaultModels.stt.model },
    activeTier: 'smart',
  },
  language: { ui: 'en', transcription: 'auto', answer: 'conversation' },
  privacy: { retentionDays: 0, saveScreenshots: false },
  profile: { name: '', role: '', company: '', about: '' },
  activeModeId: DEFAULT_MODE_ID,
  keybinds: { ...DEFAULT_KEYBINDS },
  overlay: { positions: {}, expanded: true, tab: 'insights' },
}

export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Recursively merges `patch` into `base`. Arrays and primitives are replaced. Unknown keys are dropped. */
export function mergeSettings<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return base
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in base) || value === undefined) continue
    const current = (base as Record<string, unknown>)[key]
    // Record-like objects (e.g. overlay.positions) accept new keys.
    if (isPlainObject(current) && isPlainObject(value)) {
      const isOpenRecord = key === 'positions'
      out[key] = isOpenRecord ? { ...current, ...value } : mergeSettings(current, value)
    } else {
      out[key] = value
    }
  }
  return out as T
}

/** Applies stored (possibly old or partial) settings over the defaults and validates. */
export function normalizeSettings(stored: unknown): Settings {
  const merged = mergeSettings(DEFAULT_SETTINGS, stored)
  const parsed = settingsSchema.safeParse(merged)
  if (parsed.success) return parsed.data
  // Fall back per top-level section so one bad value never wipes everything.
  const repaired: Record<string, unknown> = { ...DEFAULT_SETTINGS }
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    const section = settingsSchema.shape[key].safeParse((merged as Record<string, unknown>)[key])
    if (section.success) repaired[key] = section.data
  }
  return settingsSchema.parse(repaired)
}
