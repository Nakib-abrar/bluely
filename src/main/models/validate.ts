import defaultModels from '@shared/defaultModels.json'
import type { DeepPartial, Settings } from '@shared/settings'
import type { ModelInfo, ModelRole, ModelValidationResult } from '@shared/types'
import { modelMessage, type ModelMessageKey } from './messages'

/** Roles whose configured model is validated against the live list. */
export type ValidatedRole = ModelRole | 'stt'
export const VALIDATED_ROLES: readonly ValidatedRole[] = ['fast', 'smart', 'notes', 'stt']

const ROLE_LABEL_KEY: Record<ValidatedRole, ModelMessageKey> = {
  fast: 'roleFast',
  smart: 'roleSmart',
  notes: 'roleNotes',
  stt: 'roleStt',
}

/** Shipped default + ordered fallbacks per role (src/shared/defaultModels.json). */
export function shippedChain(role: ValidatedRole): { model: string; fallbacks: string[] } {
  const entry = defaultModels[role]
  return { model: entry.model, fallbacks: [...entry.fallbacks] }
}

function producesText(m: ModelInfo): boolean {
  return m.outputModalities.length === 0 || m.outputModalities.includes('text')
}

/**
 * Whether a model can serve a role at all: Smart answers screen questions so it must accept
 * images; STT must be a transcription model; chat roles must be text-generating, non-STT models.
 */
export function isRoleCompatible(role: ValidatedRole, m: ModelInfo): boolean {
  if (role === 'stt') return m.isStt
  if (m.isStt || !producesText(m)) return false
  return role === 'smart' ? m.supportsVision : true
}

/** Token-ish match so "mini" does not hit "gemini" and "8b" does not hit "128b". */
const token = (s: string) => new RegExp(`(^|[-/._:])${s}($|[-._:])`)

/** Earlier pattern = stronger preference. */
const PREFERENCES: Record<ValidatedRole, RegExp[]> = {
  // Live suggestions: small, fast, cheap.
  fast: [/flash-lite/, /llama-3\.3-70b/, token('8b'), token('mini'), /haiku/],
  // Assist + screen: capable multimodal models with low latency.
  smart: [/gemini-2\.5-flash(?!-lite)/, /gpt-4\.1-mini/, /claude-haiku/, /gpt-4o-mini/, /flash/],
  // Post-call notes: large context, strong writing.
  notes: [/claude-sonnet/, /gemini-2\.5-pro/, /gpt-4\.1($|:)/, /claude-opus/, /gemini-.*-pro/],
  stt: [/whisper-large-v3-turbo/, /whisper/, /transcribe/, /voxtral/],
}

function preferenceRank(role: ValidatedRole, id: string): number {
  const lower = id.toLowerCase()
  const idx = PREFERENCES[role].findIndex((re) => re.test(lower))
  return idx < 0 ? Number.POSITIVE_INFINITY : idx
}

const priceOrInf = (p: number | null) => (p === null ? Number.POSITIVE_INFINITY : p)
const flag = (b: boolean) => (b ? 1 : 0)
const cmp = (a: number, b: number) => (a < b ? -1 : a > b ? 1 : 0)
const PREVIEW = /preview|experimental|[-:]exp($|[-:])/i

/** Role-specific tiebreak value (lower is better). */
function tiebreakValue(role: ValidatedRole, m: ModelInfo): number {
  switch (role) {
    case 'notes':
      return -(m.contextLength ?? 0)
    case 'stt':
      return priceOrInf(m.pricing.audio ?? m.pricing.prompt)
    default:
      return priceOrInf(m.pricing.prompt)
  }
}

function sortKey(role: ValidatedRole, m: ModelInfo): number[] {
  return [
    preferenceRank(role, m.id),
    flag(m.id.endsWith(':free')),
    flag(PREVIEW.test(m.id)),
    tiebreakValue(role, m),
    m.id.length,
  ]
}

/**
 * Pure heuristic: the best available model for a role, or null when nothing compatible exists.
 * Ranking: role preference pattern → paid before ":free" (free tiers are heavily rate limited)
 * → stable before preview/experimental → role tiebreak (fast/smart: lowest prompt price;
 * notes: largest context; stt: lowest audio price) → shorter (canonical) id → id.
 */
export function pickBestModel(role: ValidatedRole, models: readonly ModelInfo[]): ModelInfo | null {
  const ranked = models
    .filter((m) => isRoleCompatible(role, m) && !m.id.startsWith('openrouter/'))
    .map((m) => ({ m, key: sortKey(role, m) }))
  ranked.sort((a, b) => {
    for (let i = 0; i < a.key.length; i++) {
      const c = cmp(a.key[i] ?? 0, b.key[i] ?? 0)
      if (c !== 0) return c
    }
    return a.m.id < b.m.id ? -1 : a.m.id > b.m.id ? 1 : 0
  })
  return ranked[0]?.m ?? null
}

/** Replacement for `requested`: shipped default + fallbacks first, then the heuristic. */
export function pickReplacement(
  role: ValidatedRole,
  requested: string,
  models: readonly ModelInfo[],
): ModelInfo | null {
  const byId = new Map(models.map((m) => [m.id, m]))
  const chain = shippedChain(role)
  for (const id of [chain.model, ...chain.fallbacks]) {
    if (id === requested) continue
    const m = byId.get(id)
    if (m && isRoleCompatible(role, m)) return m
  }
  return pickBestModel(
    role,
    models.filter((m) => m.id !== requested),
  )
}

function configuredModel(settings: Settings, role: ValidatedRole): string {
  return role === 'stt' ? settings.models.stt.model : settings.models[role].model
}

function replacementReason(
  role: ValidatedRole,
  requested: string,
  resolved: string | null,
  present: boolean,
): string {
  const vars = { role: modelMessage(ROLE_LABEL_KEY[role]), requested, resolved: resolved ?? '' }
  if (resolved === null) {
    return modelMessage(present ? 'incompatibleNoReplacement' : 'noReplacement', vars)
  }
  if (!present) {
    return modelMessage(
      requested === shippedChain(role).model ? 'defaultUnavailable' : 'unavailable',
      vars,
    )
  }
  if (role === 'smart') return modelMessage('noVision', vars)
  if (role === 'stt') return modelMessage('notStt', vars)
  return modelMessage('incompatible', vars)
}

/**
 * Checks the configured model of every role against the live model list (pure).
 * Missing or role-incompatible models are replaced (shipped fallbacks first, then
 * {@link pickBestModel}); `patch` holds the replacements for `SettingsStore.update`.
 * An empty list (offline, no cache) never replaces anything.
 */
export function validateDefaults(
  settings: Settings,
  models: readonly ModelInfo[],
): { results: ModelValidationResult[]; patch: DeepPartial<Settings> | null } {
  const results: ModelValidationResult[] = []
  const modelsPatch: DeepPartial<Settings['models']> = {}
  const byId = new Map(models.map((m) => [m.id, m]))
  for (const role of VALIDATED_ROLES) {
    const requested = configuredModel(settings, role)
    const current = byId.get(requested)
    if (models.length === 0 || (current && isRoleCompatible(role, current))) {
      results.push({ role, requested, resolved: requested, replaced: false, reason: null })
      continue
    }
    const replacement = pickReplacement(role, requested, models)
    const reason = replacementReason(role, requested, replacement?.id ?? null, !!current)
    if (replacement) {
      modelsPatch[role] = { model: replacement.id }
      results.push({ role, requested, resolved: replacement.id, replaced: true, reason })
    } else {
      results.push({ role, requested, resolved: requested, replaced: false, reason })
    }
  }
  const patch: DeepPartial<Settings> | null =
    Object.keys(modelsPatch).length > 0 ? { models: modelsPatch } : null
  return { results, patch }
}
