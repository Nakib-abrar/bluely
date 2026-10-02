import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings, settingsSchema, type Settings } from '@shared/settings'
import type { ModelInfo } from '@shared/types'
import { parseModelList } from '@main/models/catalog'
import {
  isRoleCompatible,
  pickBestModel,
  pickReplacement,
  validateDefaults,
} from '@main/models/validate'
import { RAW_MODELS, info, stt, vision } from './fixtures'

const LIVE = parseModelList({ data: RAW_MODELS })

function withModels(patch: Partial<Record<'fast' | 'smart' | 'notes' | 'stt', string>>): Settings {
  const p: Record<string, { model: string }> = {}
  for (const [role, model] of Object.entries(patch)) p[role] = { model }
  return mergeSettings(DEFAULT_SETTINGS, { models: p })
}

const without = (ids: string[], list: ModelInfo[] = LIVE) => list.filter((m) => !ids.includes(m.id))

describe('validateDefaults', () => {
  it('keeps every default that is available (no patch)', () => {
    const { results, patch } = validateDefaults(DEFAULT_SETTINGS, LIVE)
    expect(patch).toBeNull()
    expect(results.map((r) => r.role)).toEqual(['fast', 'smart', 'notes', 'stt'])
    for (const r of results) {
      expect(r).toMatchObject({ replaced: false, reason: null })
      expect(r.resolved).toBe(r.requested)
    }
  })

  it('never replaces anything when the model list is empty (offline)', () => {
    const { results, patch } = validateDefaults(withModels({ fast: 'gone/model' }), [])
    expect(patch).toBeNull()
    expect(results.every((r) => !r.replaced && r.reason === null)).toBe(true)
  })

  it('walks the shipped fallback chain, skipping unavailable entries', () => {
    // Default fast model and its first fallback (gpt-oss-120b) are gone.
    const models = without(['meta-llama/llama-3.3-70b-instruct', 'openai/gpt-oss-120b'])
    const { results, patch } = validateDefaults(DEFAULT_SETTINGS, models)
    expect(results[0]).toEqual({
      role: 'fast',
      requested: 'meta-llama/llama-3.3-70b-instruct',
      resolved: 'google/gemini-2.5-flash-lite',
      replaced: true,
      reason:
        'Default model meta-llama/llama-3.3-70b-instruct is not available on OpenRouter right now; using google/gemini-2.5-flash-lite.',
    })
    expect(patch).toEqual({ models: { fast: { model: 'google/gemini-2.5-flash-lite' } } })
  })

  it('tries the role default first when a user-chosen model disappears', () => {
    const { results } = validateDefaults(withModels({ notes: 'acme/retired-model' }), LIVE)
    const notes = results.find((r) => r.role === 'notes')
    expect(notes).toMatchObject({ resolved: 'anthropic/claude-sonnet-4.5', replaced: true })
    expect(notes?.reason).toBe(
      'The Notes model acme/retired-model is not available on OpenRouter right now; using anthropic/claude-sonnet-4.5.',
    )
  })

  it('falls back to the heuristic when no shipped fallback is available', () => {
    const models = [
      info('meta-llama/llama-3.1-70b-instruct', { prompt: 0.0000002 }),
      info('mistralai/ministral-8b', { prompt: 0.0000001 }),
      info('qwen/qwen-2.5-72b-instruct', { prompt: 0.00000005 }),
      vision('google/gemini-2.5-flash'),
      stt('openai/whisper-large-v3-turbo'),
      info('anthropic/claude-sonnet-4.5'),
    ]
    const { results } = validateDefaults(DEFAULT_SETTINGS, models)
    // '8b' token match wins over a cheaper model without a preferred pattern.
    expect(results[0]).toMatchObject({ resolved: 'mistralai/ministral-8b', replaced: true })
  })

  it('Smart must accept images: a text-only smart model is replaced by a vision model', () => {
    const settings = withModels({ smart: 'openai/gpt-oss-120b' })
    const { results, patch } = validateDefaults(settings, LIVE)
    const smart = results.find((r) => r.role === 'smart')
    expect(smart).toMatchObject({
      requested: 'openai/gpt-oss-120b',
      resolved: 'google/gemini-2.5-flash',
      replaced: true,
    })
    expect(smart?.reason).toContain('cannot read images')
    expect(patch).toEqual({ models: { smart: { model: 'google/gemini-2.5-flash' } } })
  })

  it('Smart fallbacks without vision are skipped', () => {
    const models = [
      info('openai/gpt-4.1-mini'), // shipped fallback but (here) text-only
      vision('anthropic/claude-haiku-4.5'),
      info('meta-llama/llama-3.3-70b-instruct'),
      info('anthropic/claude-sonnet-4.5'),
      stt('openai/whisper-large-v3-turbo'),
    ]
    const { results } = validateDefaults(DEFAULT_SETTINGS, models)
    expect(results.find((r) => r.role === 'smart')?.resolved).toBe('anthropic/claude-haiku-4.5')
  })

  it('STT must be a speech-to-text model', () => {
    const settings = withModels({ stt: 'google/gemini-2.5-flash' })
    const { results, patch } = validateDefaults(settings, LIVE)
    const r = results.find((x) => x.role === 'stt')
    expect(r).toMatchObject({ resolved: 'openai/whisper-large-v3-turbo', replaced: true })
    expect(r?.reason).toBe(
      'google/gemini-2.5-flash is not a speech-to-text model; using openai/whisper-large-v3-turbo for transcription.',
    )
    expect(patch).toEqual({ models: { stt: { model: 'openai/whisper-large-v3-turbo' } } })
  })

  it('STT heuristic picks a transcription model when no fallback exists', () => {
    const models = [
      ...without(['openai/whisper-large-v3-turbo', 'openai/whisper-large-v3']),
      stt('acme/whisper-tiny'),
    ]
    const { results } = validateDefaults(DEFAULT_SETTINGS, models)
    expect(results.find((r) => r.role === 'stt')?.resolved).toBe('acme/whisper-tiny')
  })

  it('reports (without patching) when nothing compatible exists', () => {
    const models = [info('meta-llama/llama-3.3-70b-instruct'), info('anthropic/claude-sonnet-4.5')]
    const { results, patch } = validateDefaults(DEFAULT_SETTINGS, models)
    const smart = results.find((r) => r.role === 'smart')
    expect(smart).toMatchObject({
      requested: 'google/gemini-2.5-flash',
      resolved: 'google/gemini-2.5-flash',
      replaced: false,
    })
    expect(smart?.reason).toMatch(/no replacement was found/)
    expect(results.find((r) => r.role === 'stt')?.replaced).toBe(false)
    expect(patch).toBeNull()
  })

  it('the patch applies cleanly and keeps routing preferences', () => {
    const models = without(['meta-llama/llama-3.3-70b-instruct', 'anthropic/claude-sonnet-4.5'])
    const { patch } = validateDefaults(DEFAULT_SETTINGS, models)
    const next = mergeSettings(DEFAULT_SETTINGS, patch)
    expect(settingsSchema.safeParse(next).success).toBe(true)
    expect(next.models.fast.model).toBe('openai/gpt-oss-120b')
    expect(next.models.fast.order).toEqual(DEFAULT_SETTINGS.models.fast.order)
    expect(next.models.fast.sort).toBe('latency')
    // Notes chain: gemini-2.5-pro and gpt-4.1 are not listed, gemini-2.5-flash is.
    expect(next.models.notes.model).toBe('google/gemini-2.5-flash')
    expect(next.models.notes.sort).toBe(DEFAULT_SETTINGS.models.notes.sort)
    expect(next.models.smart).toEqual(DEFAULT_SETTINGS.models.smart)
  })
})

describe('isRoleCompatible', () => {
  it('enforces per-role capabilities', () => {
    const textOnly = info('a/text')
    const img = vision('a/vision')
    const asr = stt('a/whisper')
    const imageGen = info('a/image-gen', { outputModalities: ['image'] })
    expect(isRoleCompatible('fast', textOnly)).toBe(true)
    expect(isRoleCompatible('smart', textOnly)).toBe(false)
    expect(isRoleCompatible('smart', img)).toBe(true)
    expect(isRoleCompatible('notes', asr)).toBe(false)
    expect(isRoleCompatible('stt', asr)).toBe(true)
    expect(isRoleCompatible('stt', img)).toBe(false)
    expect(isRoleCompatible('fast', imageGen)).toBe(false)
  })
})

describe('pickBestModel heuristic', () => {
  it('returns null when nothing is compatible', () => {
    expect(pickBestModel('stt', [info('a/b')])).toBeNull()
    expect(pickBestModel('fast', [])).toBeNull()
  })

  it('fast: preference patterns in order, then the lowest prompt price', () => {
    const models = [
      info('x/cheap-unknown', { prompt: 0.00000001 }),
      info('openai/gpt-4o-mini', { prompt: 0.00000015 }),
      info('meta-llama/llama-3.3-70b-instruct', { prompt: 0.00000013 }),
      info('google/gemini-2.0-flash-lite-001', { prompt: 0.00000008 }),
      info('google/gemini-2.5-flash-lite', { prompt: 0.0000001 }),
    ]
    expect(pickBestModel('fast', models)?.id).toBe('google/gemini-2.0-flash-lite-001')
    expect(pickBestModel('fast', models.slice(0, 3))?.id).toBe('meta-llama/llama-3.3-70b-instruct')
  })

  it('fast: "mini" and "8b" match whole tokens only', () => {
    const models = [
      info('google/gemini-2.5-pro', { prompt: 0.00000001 }), // contains "mini" inside "gemini"
      info('acme/model-128b', { prompt: 0.00000002 }), // contains "8b" inside "128b"
      info('openai/o4-mini', { prompt: 0.000001 }),
    ]
    expect(pickBestModel('fast', models)?.id).toBe('openai/o4-mini')
  })

  it('smart: only vision models, preferring the configured families', () => {
    const models = [
      info('openai/gpt-oss-120b', { prompt: 0.00000001 }),
      vision('x/cheap-vision', 0.00000001),
      vision('openai/gpt-4o-mini', 0.00000015),
      vision('anthropic/claude-haiku-4.5', 0.000001),
    ]
    expect(pickBestModel('smart', models)?.id).toBe('anthropic/claude-haiku-4.5')
    expect(pickBestModel('smart', [models[0]!, models[1]!])?.id).toBe('x/cheap-vision')
  })

  it('notes: capable families first, then the largest context', () => {
    const models = [
      info('x/huge-context', { contextLength: 2_000_000 }),
      info('openai/gpt-4.1-mini', { contextLength: 1_000_000 }),
      info('google/gemini-2.5-pro', { contextLength: 1_048_576 }),
    ]
    expect(pickBestModel('notes', models)?.id).toBe('google/gemini-2.5-pro')
    expect(pickBestModel('notes', [models[0]!, models[1]!])?.id).toBe('x/huge-context')
    expect(
      pickBestModel('notes', [
        info('anthropic/claude-sonnet-4', { contextLength: 200_000 }),
        info('anthropic/claude-sonnet-4.5', { contextLength: 1_000_000 }),
      ])?.id,
    ).toBe('anthropic/claude-sonnet-4.5')
  })

  it('stt: whisper-large-v3-turbo first, then other whisper, then the cheapest audio price', () => {
    expect(
      pickBestModel('stt', [
        stt('a/voxtral-mini'),
        stt('openai/whisper-large-v3'),
        stt('x/whisper-large-v3-turbo'),
      ])?.id,
    ).toBe('x/whisper-large-v3-turbo')
    expect(pickBestModel('stt', [stt('a/asr-b', 0.0000002), stt('a/asr-a', 0.0000001)])?.id).toBe(
      'a/asr-a',
    )
  })

  it('skips router models and prefers paid, stable, canonical ids', () => {
    expect(
      pickBestModel('fast', [
        info('openrouter/auto', { prompt: null }),
        info('meta-llama/llama-3.3-70b-instruct:free', { prompt: 0 }),
        info('meta-llama/llama-3.3-70b-instruct', { prompt: 0.00000013 }),
      ])?.id,
    ).toBe('meta-llama/llama-3.3-70b-instruct')
    expect(
      pickBestModel('smart', [
        vision('google/gemini-2.5-flash-preview-09-2025', 0.0000001),
        vision('google/gemini-2.5-flash', 0.0000003),
      ])?.id,
    ).toBe('google/gemini-2.5-flash')
    expect(pickBestModel('fast', [info('openrouter/auto')])).toBeNull()
  })

  it('pickReplacement never returns the requested model', () => {
    const models = [info('meta-llama/llama-3.3-70b-instruct')]
    expect(pickReplacement('fast', 'meta-llama/llama-3.3-70b-instruct', models)).toBeNull()
  })
})
