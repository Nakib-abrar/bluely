import type { ModelInfo, ProviderSort, SpeedStats } from '@shared/types'

/**
 * Provider-agnostic chat interface. OpenRouter implements it today; direct OpenAI,
 * Anthropic, Gemini or Groq providers can implement it later without touching UI code.
 */

export type ChatContentPart =
  | { type: 'text'; text: string }
  /** `url` is an https URL or a data: URL (e.g. "data:image/jpeg;base64,…"). */
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } }

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | ChatContentPart[]
}

/** OpenRouter provider routing preferences (maps to the request's `provider` object). */
export interface ProviderRouting {
  sort?: ProviderSort
  /** Provider slugs to try first, e.g. ["groq", "cerebras"]. */
  order?: string[]
  allowFallbacks?: boolean
}

/**
 * OpenRouter's unified `reasoning` request object (see providers/llm/reasoning.ts for when
 * Bluely sends it). Reasoning tokens count against `maxTokens`.
 */
export interface ReasoningOptions {
  effort?: 'minimal' | 'low' | 'medium' | 'high'
  /** Keep the reasoning text out of the response (the model still reasons). */
  exclude?: boolean
}

export interface ChatRequest {
  model: string
  messages: ChatMessage[]
  maxTokens?: number
  temperature?: number
  /** 'json_object' asks for a JSON response where the model supports it. */
  responseFormat?: 'text' | 'json_object'
  routing?: ProviderRouting
  reasoning?: ReasoningOptions
  signal?: AbortSignal
  /** Short label for logs, e.g. "auto" or "post_notes". */
  tag?: string
}

export interface ChatUsage {
  promptTokens: number | null
  /** Billed output tokens, reasoning included. */
  completionTokens: number | null
  costUsd: number | null
  /** Part of `completionTokens` spent on (hidden) reasoning, when the provider reports it. */
  reasoningTokens?: number | null
}

export type ChatStreamEvent =
  /** First chunk metadata: generation id, the model that actually served, provider name. */
  | { type: 'meta'; generationId: string | null; model: string | null; provider: string | null }
  | { type: 'delta'; text: string }
  | { type: 'done'; finishReason: string | null; usage: ChatUsage | null; stats: SpeedStats }

export interface ChatResult {
  text: string
  stats: SpeedStats
  usage: ChatUsage | null
  finishReason: string | null
}

export interface LLMProvider {
  readonly id: string
  /**
   * Streams a chat completion. Yields `meta` (once, when known), `delta`s, then exactly one
   * `done`. Throws ProviderError (code 'aborted' when `signal` fires).
   */
  streamChat(req: ChatRequest): AsyncIterable<ChatStreamEvent>
  /** Convenience: runs streamChat to completion and returns the full text + stats. */
  complete(req: ChatRequest): Promise<ChatResult>
  /** Lists chat + STT models. Cached; `refresh` forces a network fetch. */
  listModels(opts?: { refresh?: boolean }): Promise<ModelInfo[]>
  /** Warms the HTTP connection (called when a session starts). */
  prewarm(): Promise<void>
  /** Optional exact stats from the provider after a request finished. */
  getGenerationStats?(generationId: string): Promise<Partial<SpeedStats> | null>
}
