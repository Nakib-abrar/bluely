import { describe, expect, it } from 'vitest'
import defaults from '@shared/defaultModels.json'
import { answerBudget, reasonsByDefault } from '@main/providers/llm/reasoning'

describe('reasonsByDefault', () => {
  it('knows the models that think before answering', () => {
    for (const id of [
      'openai/gpt-oss-120b',
      'openai/gpt-oss-20b',
      'openai/o3-mini',
      'openai/o4-mini',
      'openai/gpt-5',
      'openai/gpt-5-mini',
      'google/gemini-2.5-flash',
      'google/gemini-2.5-pro',
      'google/gemini-3-pro-preview',
      'deepseek/deepseek-r1',
      'qwen/qwen3-235b-a22b-thinking-2507',
      'anthropic/claude-3.7-sonnet:thinking',
    ]) {
      expect(reasonsByDefault(id), id).toBe(true)
    }
  })

  it('leaves non-reasoning and opt-in reasoning models alone', () => {
    for (const id of [
      'meta-llama/llama-3.3-70b-instruct',
      'google/gemini-2.5-flash-lite',
      'google/gemini-2.0-flash-001',
      'openai/gpt-4o-mini',
      'openai/gpt-4.1-mini',
      'openai/gpt-5-chat',
      'anthropic/claude-sonnet-4.5',
      'anthropic/claude-haiku-4.5',
    ]) {
      expect(reasonsByDefault(id), id).toBe(false)
    }
  })

  it('covers the shipped Fast fallback that triggered the bug', () => {
    expect(defaults.fast.fallbacks[0]).toBe('openai/gpt-oss-120b')
    expect(reasonsByDefault(defaults.fast.fallbacks[0]!)).toBe(true)
    expect(reasonsByDefault(defaults.fast.model)).toBe(false)
  })
})

describe('answerBudget', () => {
  it('passes the cap through unchanged for models that do not think', () => {
    expect(answerBudget('meta-llama/llama-3.3-70b-instruct', 450)).toEqual({ maxTokens: 450 })
    // No reasoning object: on Claude it would switch extended thinking on.
    expect(answerBudget('anthropic/claude-sonnet-4.5', 3000, 'medium')).toEqual({
      maxTokens: 3000,
    })
  })

  it('asks reasoning models to think briefly and keeps room for the answer', () => {
    const live = answerBudget('openai/gpt-oss-120b', 450)
    expect(live.reasoning).toEqual({ effort: 'low', exclude: true })
    // OpenRouter gives budget-based models max(20 % of max_tokens, 1024) to think.
    const thinking = Math.max(live.maxTokens * 0.2, 1024)
    expect(live.maxTokens - thinking).toBeGreaterThanOrEqual(450)

    const notes = answerBudget('google/gemini-2.5-pro', 3000, 'medium')
    expect(notes.reasoning).toEqual({ effort: 'medium', exclude: true })
    // 'medium' thinks with up to half of max_tokens.
    expect(notes.maxTokens - Math.max(notes.maxTokens * 0.5, 1024)).toBeGreaterThanOrEqual(3000)
  })
})
