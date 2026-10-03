import { describe, expect, it } from 'vitest'
import type { ModelInfo, ModelStat } from '@shared/types'
import {
  defaultLatencySelection,
  filterModelsForRole,
  formatBytes,
  formatContextLength,
  formatModelPrice,
  formatMs,
  modelFitsRole,
  modelLabel,
  modelMeta,
  parseProviderOrder,
  perMillion,
  rollingStatRows,
  searchModels,
  shortModelLabel,
} from '@renderer/settings/lib/models'

function model(id: string, extra: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id,
    name: id,
    contextLength: 128000,
    pricing: { prompt: 1e-7, completion: 4e-7, request: null, image: null, audio: null },
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportsVision: false,
    supportsAudioInput: false,
    isStt: false,
    description: null,
    ...extra,
  }
}

const chat = model('meta-llama/llama-3.3-70b-instruct', { name: 'Meta: Llama 3.3 70B Instruct' })
const vision = model('google/gemini-2.5-flash', {
  name: 'Google: Gemini 2.5 Flash',
  supportsVision: true,
  inputModalities: ['text', 'image'],
})
const stt = model('openai/whisper-large-v3-turbo', { name: 'Whisper', isStt: true })
const imageOut = model('vendor/image-gen', { outputModalities: ['image'] })
const ALL = [chat, vision, stt, imageOut]

describe('role filtering', () => {
  it('Smart only lists vision chat models', () => {
    expect(filterModelsForRole(ALL, 'smart').map((m) => m.id)).toEqual([vision.id])
  })
  it('STT only lists speech-to-text models', () => {
    expect(filterModelsForRole(ALL, 'stt').map((m) => m.id)).toEqual([stt.id])
  })
  it('Fast/Notes list text-output chat models (not STT, not image generators)', () => {
    expect(filterModelsForRole(ALL, 'fast').map((m) => m.id)).toEqual([chat.id, vision.id])
    expect(modelFitsRole(stt, 'notes')).toBe(false)
    expect(modelFitsRole(imageOut, 'notes')).toBe(false)
    // Missing modality info is treated as text output.
    expect(modelFitsRole(model('x/y', { outputModalities: [] }), 'fast')).toBe(true)
  })
})

describe('searchModels', () => {
  it('matches every term against id and name, case-insensitively', () => {
    expect(searchModels(ALL, 'LLAMA 70b').map((m) => m.id)).toEqual([chat.id])
    expect(searchModels(ALL, 'google flash').map((m) => m.id)).toEqual([vision.id])
    expect(searchModels(ALL, 'nothing-like-this')).toEqual([])
  })
  it('returns everything for an empty query', () => {
    expect(searchModels(ALL, '   ')).toHaveLength(ALL.length)
  })
})

describe('formatting', () => {
  it('formats context length', () => {
    expect(formatContextLength(131072)).toBe('131K ctx')
    expect(formatContextLength(128000)).toBe('128K ctx')
    expect(formatContextLength(1048576)).toBe('1M ctx')
    expect(formatContextLength(1_500_000)).toBe('1.5M ctx')
    expect(formatContextLength(512)).toBe('512 ctx')
    expect(formatContextLength(0)).toBeNull()
    expect(formatContextLength(null)).toBeNull()
  })

  it('formats per-million prices compactly', () => {
    expect(perMillion(0.13e-6)).toBe('$0.13/M')
    expect(perMillion(0.075e-6)).toBe('$0.075/M')
    expect(perMillion(2.5e-6)).toBe('$2.50/M')
    expect(perMillion(0)).toBe('free')
    expect(perMillion(null)).toBe('—')
  })

  it('formats model prices', () => {
    expect(formatModelPrice(chat)).toBe('$0.10/M in · $0.40/M out')
    expect(
      formatModelPrice({
        pricing: { prompt: 0, completion: 0, request: null, image: null, audio: null },
      }),
    ).toBe('Free')
    expect(
      formatModelPrice({
        pricing: { prompt: null, completion: null, request: null, image: null, audio: null },
      }),
    ).toBeNull()
  })

  it('builds the option meta line', () => {
    expect(modelMeta(chat)).toBe(
      'meta-llama/llama-3.3-70b-instruct · 128K ctx · $0.10/M in · $0.40/M out',
    )
    expect(modelMeta(chat, false)).toBe('128K ctx · $0.10/M in · $0.40/M out')
  })

  it('formats milliseconds and bytes', () => {
    expect(formatMs(212.4)).toBe('212 ms')
    expect(formatMs(1240)).toBe('1.24 s')
    expect(formatMs(12_400)).toBe('12.4 s')
    expect(formatMs(null)).toBe('—')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(20 * 1024 * 1024)).toBe('20 MB')
    expect(formatBytes(1_284_000)).toBe('1.2 MB')
  })
})

describe('labels', () => {
  it('falls back to the id when the catalog lacks a model', () => {
    expect(modelLabel(ALL, chat.id)).toBe('Meta: Llama 3.3 70B Instruct')
    expect(modelLabel([], 'a/b')).toBe('a/b')
  })
  it('drops the vendor prefix for compact labels', () => {
    expect(shortModelLabel(ALL, chat.id)).toBe('Llama 3.3 70B Instruct')
    expect(shortModelLabel(ALL, stt.id)).toBe('Whisper')
    expect(shortModelLabel([], 'openai/gpt-4o-mini')).toBe('gpt-4o-mini')
  })
})

describe('provider order + latency defaults', () => {
  it('parses pinned providers', () => {
    expect(parseProviderOrder('Groq,  cerebras, groq')).toEqual(['groq', 'cerebras'])
    expect(parseProviderOrder(' ,, ')).toEqual([])
    expect(parseProviderOrder('a b c d e f g h i j k l')).toHaveLength(10)
  })
  it('defaults the latency test to the three role models, deduped', () => {
    expect(defaultLatencySelection({ fast: 'a', smart: 'b', notes: 'a' })).toEqual(['a', 'b'])
  })
})

describe('rollingStatRows', () => {
  const stat = (model: string, provider: string | null, ttftP50: number): ModelStat => ({
    model,
    provider,
    samples: 5,
    ttftP50,
    ttftP90: ttftP50 * 2,
    totalP50: ttftP50 * 4,
    tokensPerSecP50: 100,
    updatedAt: 1,
  })

  it('gives every (model, provider) row its own key and keeps a model together', () => {
    // main sends one row per (model, provider), most recently updated first.
    const rows = rollingStatRows([
      stat('meta-llama/llama-3.3-70b-instruct', 'Groq', 210),
      stat('google/gemini-2.5-flash', 'Google AI Studio', 500),
      stat('meta-llama/llama-3.3-70b-instruct', 'Cerebras', 180),
      stat('openai/gpt-4o-mini', null, 700),
    ])
    const keys = rows.map((r) => r.key)
    expect(new Set(keys).size).toBe(rows.length)
    expect(rows.map((r) => [r.model, r.stat.provider])).toEqual([
      ['meta-llama/llama-3.3-70b-instruct', 'Groq'],
      ['meta-llama/llama-3.3-70b-instruct', 'Cerebras'],
      ['google/gemini-2.5-flash', 'Google AI Studio'],
      ['openai/gpt-4o-mini', null],
    ])
    expect(rows[1]?.stat.ttftP50).toBe(180)
  })

  it('also works with one aggregate row per model', () => {
    const rows = rollingStatRows([stat('a/x', null, 1), stat('b/y', 'Groq', 2)])
    expect(rows.map((r) => r.key)).toEqual(['a/x|', 'b/y|Groq'])
  })
})
