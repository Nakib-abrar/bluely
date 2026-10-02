import type { ModelInfo } from '@shared/types'

/** Raw GET /models entry in OpenRouter's shape. */
export function rawModel(
  id: string,
  opts: {
    name?: string
    ctx?: number | null
    prompt?: string
    completion?: string
    audio?: string
    input?: string[]
    output?: string[]
    modality?: string
    omitModalityArrays?: boolean
    description?: string
  } = {},
): Record<string, unknown> {
  const input = opts.input ?? ['text']
  const output = opts.output ?? ['text']
  return {
    id,
    canonical_slug: id,
    name: opts.name ?? id,
    created: 1730000000,
    description: opts.description ?? `${id} description`,
    context_length: opts.ctx === undefined ? 128000 : opts.ctx,
    architecture: {
      modality: opts.modality ?? `${input.join('+')}->${output.join('+')}`,
      ...(opts.omitModalityArrays ? {} : { input_modalities: input, output_modalities: output }),
      tokenizer: 'Other',
    },
    pricing: {
      prompt: opts.prompt ?? '0.0000001',
      completion: opts.completion ?? '0.0000004',
      request: '0',
      image: '0',
      ...(opts.audio !== undefined ? { audio: opts.audio } : {}),
    },
    top_provider: { context_length: opts.ctx ?? 128000, max_completion_tokens: 8192 },
    supported_parameters: ['max_tokens', 'temperature'],
  }
}

/** A realistic subset of the live list (defaults, fallbacks, STT, routers, free variants). */
export const RAW_MODELS = [
  rawModel('meta-llama/llama-3.3-70b-instruct', { prompt: '0.00000013', ctx: 131072 }),
  rawModel('openai/gpt-oss-120b', { prompt: '0.00000005' }),
  rawModel('google/gemini-2.5-flash-lite', { input: ['text', 'image'], ctx: 1048576 }),
  rawModel('google/gemini-2.5-flash', {
    input: ['text', 'image', 'audio', 'file'],
    prompt: '0.0000003',
    ctx: 1048576,
  }),
  rawModel('openai/gpt-4o-mini', { input: ['text', 'image', 'file'], prompt: '0.00000015' }),
  rawModel('anthropic/claude-sonnet-4.5', {
    input: ['text', 'image'],
    prompt: '0.000003',
    ctx: 1000000,
  }),
  rawModel('anthropic/claude-haiku-4.5', { input: ['text', 'image'], prompt: '0.000001' }),
  rawModel('openai/whisper-large-v3-turbo', {
    input: ['audio'],
    prompt: '0',
    audio: '0.00000011',
    ctx: null,
  }),
  rawModel('openai/whisper-large-v3', { input: ['audio'], prompt: '0', audio: '0.00000031' }),
  rawModel('openrouter/auto', { prompt: '-1', completion: '-1', input: ['text', 'image'] }),
  rawModel('google/gemini-2.5-flash-image', {
    input: ['text', 'image'],
    output: ['image', 'text'],
  }),
]

/** Compact ModelInfo builder for pure validation tests. */
export function info(
  id: string,
  opts: Partial<Omit<ModelInfo, 'id'>> & {
    prompt?: number | null
    audioPrice?: number | null
  } = {},
): ModelInfo {
  const { prompt, audioPrice, ...rest } = opts
  const inputModalities =
    rest.inputModalities ?? (rest.supportsVision ? ['text', 'image'] : ['text'])
  return {
    id,
    name: id,
    contextLength: 128000,
    pricing: {
      prompt: prompt === undefined ? 0.0000001 : prompt,
      completion: 0.0000004,
      request: 0,
      image: 0,
      audio: audioPrice ?? null,
    },
    inputModalities,
    outputModalities: ['text'],
    supportsVision: inputModalities.includes('image'),
    supportsAudioInput: inputModalities.includes('audio'),
    isStt: false,
    description: null,
    ...rest,
  }
}

export const stt = (id: string, audioPrice: number | null = 0.0000001): ModelInfo =>
  info(id, { inputModalities: ['audio'], isStt: true, audioPrice, prompt: 0 })

export const vision = (id: string, prompt = 0.0000001): ModelInfo =>
  info(id, { inputModalities: ['text', 'image'], prompt })
