import { describe, expect, it } from 'vitest'
import { chunkText, splitSentences } from '@main/knowledge/chunker'
import { estimateTokens, tokenWeight } from '@main/knowledge/tokens'
import { banglaText, englishText } from './fixtures'

/** Length of the longest suffix of `prev` that `next` starts with (at least `min` chars). */
function overlapLength(prev: string, next: string, min = 1): number {
  for (let len = Math.min(prev.length, next.length - 1); len >= min; len--) {
    if (next.startsWith(prev.slice(prev.length - len))) return len
  }
  return 0
}

function words(text: string): string[] {
  return text.split(/\s+/).filter(Boolean)
}

describe('estimateTokens', () => {
  it('counts ~4 ASCII characters per token', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
    expect(estimateTokens('a'.repeat(400))).toBe(100)
  })

  it('counts non-ASCII characters as half a token each (surrogate pairs once)', () => {
    expect(tokenWeight('আমি')).toBe(1.5)
    expect(estimateTokens('আমি')).toBe(2)
    expect(tokenWeight('é')).toBe(0.5)
    expect(tokenWeight('😀')).toBe(0.5)
    expect(tokenWeight('ab😀')).toBe(1)
  })

  it('is additive over concatenation', () => {
    const a = 'Hello, world. '
    const b = 'আমাদের কোম্পানি।'
    expect(tokenWeight(a + b)).toBe(tokenWeight(a) + tokenWeight(b))
  })
})

describe('splitSentences', () => {
  it('splits Latin sentences and keeps closing quotes with their sentence', () => {
    expect(splitSentences('He said "Stop." Then he left! Did he? Yes…  Done')).toEqual([
      'He said "Stop."',
      'Then he left!',
      'Did he?',
      'Yes…',
      'Done',
    ])
  })

  it('does not split decimals or words without a following space', () => {
    expect(splitSentences('Revenue grew 3.5 percent to $1.2M.')).toEqual([
      'Revenue grew 3.5 percent to $1.2M.',
    ])
  })

  it('splits Bangla sentences on the danda and question mark', () => {
    expect(splitSentences('আমি ভাত খাই। তুমি কী খাও? সে বই পড়ে।')).toEqual([
      'আমি ভাত খাই।',
      'তুমি কী খাও?',
      'সে বই পড়ে।',
    ])
  })

  it('splits CJK sentences without spaces, never before a closing quote', () => {
    expect(splitSentences('你好。今天天气很好！「走吧。」他说。')).toEqual([
      '你好。',
      '今天天气很好！',
      '「走吧。」',
      '他说。',
    ])
  })
})

describe('chunkText', () => {
  it('returns no chunks for empty or blank text', () => {
    expect(chunkText('')).toEqual([])
    expect(chunkText('   \n\n \t \n')).toEqual([])
  })

  it('keeps short text as one chunk with its paragraph and line breaks', () => {
    const text = 'Title\n\nFirst paragraph. Second sentence.\nA new line.\n\nLast paragraph.'
    expect(chunkText(text)).toEqual([text])
  })

  it('normalizes CRLF and runs of blank lines inside a chunk', () => {
    expect(chunkText('One.\r\n\r\n\r\n\r\nTwo.\r\nThree.')).toEqual(['One.\n\nTwo.\nThree.'])
  })

  it('packs long text into chunks of at most 800 tokens with ~100-token overlap', () => {
    const text = englishText(400)
    const chunks = chunkText(text)
    expect(chunks.length).toBeGreaterThan(3)
    const sourceWords = new Set(words(text))
    chunks.forEach((chunk, i) => {
      expect(chunk.trim()).toBe(chunk)
      expect(chunk.length).toBeGreaterThan(0)
      expect(estimateTokens(chunk)).toBeLessThanOrEqual(800)
      // Full chunks: only the last one may be small.
      if (i < chunks.length - 1) expect(estimateTokens(chunk)).toBeGreaterThan(700)
      // Never cut inside a word.
      for (const w of words(chunk)) expect(sourceWords.has(w)).toBe(true)
      if (i === 0) return
      const prev = chunks[i - 1] as string
      const len = overlapLength(prev, chunk, 20)
      const tail = prev.slice(prev.length - len)
      expect(tokenWeight(tail)).toBeGreaterThan(85)
      expect(tokenWeight(tail)).toBeLessThanOrEqual(100)
      // The overlap starts at a word boundary in the previous chunk.
      expect(prev[prev.length - len - 1]).toMatch(/\s/)
    })
  })

  it('covers every sentence of the source in full', () => {
    const text = englishText(250)
    const joined = chunkText(text).join('\n')
    for (const sentence of text.split(/(?<=\.)\s+/)) expect(joined).toContain(sentence)
  })

  it('starts chunks (after the overlap) at sentence boundaries when sentences are short', () => {
    const chunks = chunkText(englishText(300))
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1] as string
      const chunk = chunks[i] as string
      const fresh = chunk.slice(overlapLength(prev, chunk, 20)).trimStart()
      expect(fresh).toMatch(/^(The team|Our customer|The product|Each region|The pilot) /)
    }
  })

  it('splits an overlong sentence by words', () => {
    const sentence = Array.from({ length: 3000 }, (_, i) => `word${i}`).join(' ')
    const chunks = chunkText(sentence)
    expect(chunks.length).toBeGreaterThan(5)
    const sourceWords = new Set(words(sentence))
    for (const chunk of chunks) {
      expect(estimateTokens(chunk)).toBeLessThanOrEqual(800)
      for (const w of words(chunk)) expect(sourceWords.has(w)).toBe(true)
    }
    expect(new Set(chunks.flatMap(words))).toEqual(sourceWords)
  })

  it('splits a single word longer than a chunk as a last resort', () => {
    const blob = 'x'.repeat(10_000)
    const chunks = chunkText(`Intro sentence. ${blob} Outro sentence.`)
    for (const chunk of chunks) {
      expect(chunk.length).toBeGreaterThan(0)
      expect(estimateTokens(chunk)).toBeLessThanOrEqual(800)
    }
    expect(chunks.join('').replace(/[^x]/g, '').length).toBeGreaterThanOrEqual(10_000)
  })

  it('chunks Bangla text on danda boundaries within the token budget', () => {
    const text = banglaText(200)
    const chunks = chunkText(text)
    expect(chunks.length).toBeGreaterThan(3)
    const sourceWords = new Set(words(text))
    chunks.forEach((chunk, i) => {
      expect(estimateTokens(chunk)).toBeLessThanOrEqual(800)
      for (const w of words(chunk)) expect(sourceWords.has(w)).toBe(true)
      // Every chunk ends at the end of a sentence.
      expect(chunk.endsWith('।')).toBe(true)
      if (i === 0) return
      const prev = chunks[i - 1] as string
      const len = overlapLength(prev, chunk, 10)
      expect(tokenWeight(prev.slice(prev.length - len))).toBeGreaterThan(80)
      expect(tokenWeight(prev.slice(prev.length - len))).toBeLessThanOrEqual(100)
    })
  })

  it('honours custom sizes and clamps silly options', () => {
    const text = englishText(60)
    const small = chunkText(text, { chunkTokens: 60, overlapTokens: 10 })
    for (const chunk of small) expect(estimateTokens(chunk)).toBeLessThanOrEqual(60)
    expect(small.length).toBeGreaterThan(chunkText(text).length)

    const noOverlap = chunkText(text, { chunkTokens: 60, overlapTokens: 0 })
    expect(noOverlap.join(' ').replace(/\n\n/g, ' ')).toBe(text.replace(/\n\n/g, ' '))

    // Non-numbers fall back to the defaults.
    expect(chunkText(text, { chunkTokens: Number.NaN, overlapTokens: Infinity })).toEqual(
      chunkText(text),
    )

    // Overlap larger than the chunk is clamped to half the chunk; tiny chunks are raised.
    for (const chunk of chunkText(text, { chunkTokens: 1, overlapTokens: 500 })) {
      expect(estimateTokens(chunk)).toBeLessThanOrEqual(16)
    }
  })
})
