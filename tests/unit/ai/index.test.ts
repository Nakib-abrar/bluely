import { describe, expect, it } from 'vitest'
import * as ai from '@main/ai'

describe('@main/ai barrel', () => {
  it('exposes the APIs the integrator wires', () => {
    for (const name of [
      'buildContext',
      'retrievalQueryFrom',
      'formatTimestamp',
      'formatTranscript',
      'generatePostCall',
      'RunningSummarizer',
      'extractJsonObject',
      'estimateTokens',
      'estimateMessagesTokens',
      'messagesToText',
      'renderNotesMarkdown',
      'renderActionItemsMarkdown',
      'renderEmailText',
      'sessionMarkdown',
      'basePrompt',
      'actionInstruction',
      'postNotesPrompt',
      'postActionsPrompt',
      'postEmailPrompt',
    ] as const) {
      expect(typeof ai[name], name).toBe('function')
    }
    expect(ai.DEFAULT_MAX_PROMPT_TOKENS).toBe(6000)
    expect(ai.DEFAULT_CONTEXT_MINUTES).toBe(6)
    expect(ai.DEFAULT_MAX_TRANSCRIPT_TOKENS).toBe(60_000)
    expect(ai.INTERVIEW_MODE_ID).toBe('builtin-interview')
  })
})
