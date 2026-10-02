import { describe, expect, it } from 'vitest'
import {
  IMAGE_TOKENS,
  estimateMessagesTokens,
  estimateTokens,
  messagesToText,
} from '@main/ai/tokens'

describe('estimateTokens', () => {
  it('counts ~4 ASCII chars per token', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
    expect(estimateTokens('a'.repeat(400))).toBe(100)
  })

  it('counts non-ASCII characters as ~0.5 token each', () => {
    // 10 Bangla characters → 5 tokens.
    expect(estimateTokens('আমি বাংলায়')).toBeGreaterThanOrEqual(5)
    expect(estimateTokens('ééééé')).toBe(3)
    expect(estimateTokens('日本語日本語')).toBe(3)
  })

  it('counts a surrogate pair (emoji) as one character', () => {
    expect(estimateTokens('😀😀')).toBe(1)
    expect(estimateTokens('ab😀')).toBe(Math.ceil(2 / 4 + 0.5))
  })
})

describe('estimateMessagesTokens', () => {
  it('adds ~4 per message and ~800 per image', () => {
    const text = 'a'.repeat(40)
    expect(estimateMessagesTokens([{ role: 'user', content: text }])).toBe(4 + 10)
    expect(
      estimateMessagesTokens([
        { role: 'system', content: text },
        {
          role: 'user',
          content: [
            { type: 'text', text },
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } },
          ],
        },
      ]),
    ).toBe(4 + 10 + 4 + 10 + IMAGE_TOKENS)
    expect(IMAGE_TOKENS).toBe(800)
  })
})

describe('messagesToText', () => {
  it('flattens roles and replaces images with a placeholder', () => {
    const out = messagesToText([
      { role: 'system', content: 'sys' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,SECRET' } },
        ],
      },
    ])
    expect(out).toBe('[system]\nsys\n\n[user]\nhello\n\n[image]')
    expect(out).not.toContain('SECRET')
  })
})
