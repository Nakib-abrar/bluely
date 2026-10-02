/**
 * Pure helpers for the AI Models page and model pickers (unit-tested in tests/unit/settingsui).
 */
import { t } from '@shared/i18n'
import type { ModelInfo, ModelRole } from '@shared/types'
import { formatPerMillion } from '../../lib/format'

/** Picker roles: the three chat roles plus speech-to-text. */
export type PickerRole = ModelRole | 'stt'

function outputsText(m: ModelInfo): boolean {
  return m.outputModalities.length === 0 || m.outputModalities.includes('text')
}

/** Whether a model can serve a role: Smart needs vision, STT needs a transcription model. */
export function modelFitsRole(m: ModelInfo, role: PickerRole): boolean {
  if (role === 'stt') return m.isStt
  if (m.isStt || !outputsText(m)) return false
  if (role === 'smart') return m.supportsVision
  return true
}

export function filterModelsForRole(models: readonly ModelInfo[], role: PickerRole): ModelInfo[] {
  return models.filter((m) => modelFitsRole(m, role))
}

/**
 * Case-insensitive search over id and name. Every whitespace-separated term must match, so
 * "llama groq 70b" narrows quickly. Results keep the input order.
 */
export function searchModels(models: readonly ModelInfo[], query: string): ModelInfo[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return [...models]
  return models.filter((m) => {
    const hay = `${m.id} ${m.name}`.toLowerCase()
    return terms.every((term) => hay.includes(term))
  })
}

/** 131072 → "131K ctx", 1048576 → "1M ctx", 2000000 → "2M ctx". */
export function formatContextLength(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n) || n <= 0) return null
  if (n >= 1_000_000) {
    const m = n / 1_000_000
    const size = Number.isInteger(Math.round(m * 10) / 10) ? Math.round(m) : m.toFixed(1)
    return t('settings.picker.context', { size: `${size}M` })
  }
  if (n >= 1000) return t('settings.picker.context', { size: `${Math.round(n / 1000)}K` })
  return t('settings.picker.context', { size: String(n) })
}

/** formatPerMillion with one trailing zero trimmed from sub-dollar prices: "$0.130/M" → "$0.13/M". */
export function perMillion(perToken: number | null | undefined): string {
  return formatPerMillion(perToken).replace(/^(\$0\.\d\d)0\/M$/, '$1/M')
}

/** "$0.13/M in · $0.40/M out", "Free", or null when the price is unknown. */
export function formatModelPrice(m: Pick<ModelInfo, 'pricing'>): string | null {
  const { prompt, completion, audio } = m.pricing
  if (prompt == null && completion == null) {
    return audio != null ? t('settings.picker.priceAudio', { price: perMillion(audio) }) : null
  }
  if ((prompt ?? 0) === 0 && (completion ?? 0) === 0) return t('settings.picker.free')
  return t('settings.picker.price', { input: perMillion(prompt), output: perMillion(completion) })
}

/** "google/gemini-2.5-flash · 1M ctx · $0.30/M in · $2.50/M out" (id optional). */
export function modelMeta(model: ModelInfo, withId = true): string {
  return [
    withId ? model.id : null,
    formatContextLength(model.contextLength),
    formatModelPrice(model),
  ]
    .filter(Boolean)
    .join(' · ')
}

/** "groq, Cerebras ,, together" → ["groq", "cerebras", "together"] (deduped, max 10, 64 chars each). */
export function parseProviderOrder(input: string): string[] {
  const out: string[] = []
  for (const raw of input.split(/[,\s]+/)) {
    const slug = raw.trim().toLowerCase().slice(0, 64)
    if (slug && !out.includes(slug)) out.push(slug)
    if (out.length >= 10) break
  }
  return out
}

/** Best display name for a model id (falls back to the id when the catalog has not loaded). */
export function modelLabel(models: readonly ModelInfo[], id: string): string {
  return models.find((m) => m.id === id)?.name ?? id
}

/** Compact name for tables and chips: drops the "Vendor: " prefix OpenRouter puts on names. */
export function shortModelLabel(models: readonly ModelInfo[], id: string): string {
  const name = models.find((m) => m.id === id)?.name
  if (!name) return id.split('/').pop() ?? id
  const idx = name.indexOf(': ')
  return idx > 0 && idx < name.length - 2 ? name.slice(idx + 2) : name
}

/** 420 → "420 ms", 1240 → "1.24 s", null → "—". */
export function formatMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`
}

/** 1536 → "1.5 KB", 20971520 → "20 MB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  const text =
    value >= 10 || Number.isInteger(value) ? Math.round(value).toString() : value.toFixed(1)
  return `${text} ${units[unit]}`
}

/** Default latency-test selection: the three chat role models, deduped, in role order. */
export function defaultLatencySelection(models: { fast: string; smart: string; notes: string }) {
  return [...new Set([models.fast, models.smart, models.notes])]
}
