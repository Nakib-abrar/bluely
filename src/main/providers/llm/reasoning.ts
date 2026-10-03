import type { ReasoningOptions } from './LLMProvider'

/*
 * Reasoning ("thinking") models spend part of `max_tokens` on reasoning before the first word of
 * the answer. With Bluely's small answer caps (a few hundred tokens for live suggestions) such a
 * model can use the whole budget thinking and return nothing, or an answer cut off mid-sentence.
 *
 * For models that think by default we therefore (1) ask for brief reasoning, (2) keep it out of
 * the stream (Bluely never shows it) and (3) add headroom on top of the answer cap. We do NOT send
 * a `reasoning` object to other models: on models where reasoning is opt-in (e.g. Anthropic
 * Claude, Gemini Flash-Lite) that would switch extended thinking ON and make answers slower.
 */

/** Model ids (OpenRouter slugs) that reason before answering unless told otherwise. */
const THINKS_BY_DEFAULT: readonly RegExp[] = [
  /^openai\/o\d/, // o1, o3, o4-mini, …
  /^openai\/gpt-oss-/,
  // gpt-5, -mini, -nano, -pro (not the chat variants; gpt-5.1+ default to no reasoning)
  /^openai\/gpt-5(?!\.)(?![\w-]*chat)/,
  /^google\/gemini-(?:2\.5|[3-9](?:\.\d+)?)-(?:pro|flash)(?!-lite)/,
  /^deepseek\/deepseek-r1/,
  /^x-ai\/grok-3-mini/,
  /^qwen\/[\w.-]*thinking/,
  /:thinking$/,
]

/**
 * Extra max_tokens per effort level. OpenRouter turns an effort into a thinking budget of
 * max(max_tokens × ratio, 1024) for budget-based models (Gemini), with ratio 0.2 for 'low' and
 * 0.5 for 'medium'. So 'low' needs ≥ 1024 on top of the answer, and 'medium' needs about the
 * answer's size again (the answer keeps the other half).
 */
const LOW_EFFORT_HEADROOM = 1024
const MEDIUM_EFFORT_MIN_HEADROOM = 4096

/** True for models that think before answering by default (see THINKS_BY_DEFAULT). */
export function reasonsByDefault(model: string): boolean {
  const id = model.trim().toLowerCase()
  return THINKS_BY_DEFAULT.some((re) => re.test(id))
}

export interface AnswerBudget {
  /** max_tokens for the request: the answer cap plus reasoning headroom when needed. */
  maxTokens: number
  /** OpenRouter `reasoning` object; undefined for models that don't think by default. */
  reasoning?: ReasoningOptions
}

/**
 * Request settings for an answer of up to `answerTokens` tokens. Live answers use 'low' effort
 * (speed matters); post-call notes use 'medium' (quality matters, with more headroom).
 */
export function answerBudget(
  model: string,
  answerTokens: number,
  effort: 'low' | 'medium' = 'low',
): AnswerBudget {
  if (!reasonsByDefault(model)) return { maxTokens: answerTokens }
  const headroom =
    effort === 'low' ? LOW_EFFORT_HEADROOM : Math.max(MEDIUM_EFFORT_MIN_HEADROOM, answerTokens)
  return { maxTokens: answerTokens + headroom, reasoning: { effort, exclude: true } }
}
