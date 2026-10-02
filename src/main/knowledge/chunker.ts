import { KNOWLEDGE_LIMITS } from '@shared/constants'
import { codeUnitWeight, tokenWeight } from './tokens'

export interface ChunkOptions {
  /** Target maximum size of a chunk in estimated tokens. Default 800. */
  chunkTokens?: number
  /** How much of the previous chunk's tail is repeated at the start of the next. Default 100. */
  overlapTokens?: number
}

/** A piece of text that is never split further, plus the whitespace that precedes it. */
interface Unit {
  text: string
  /** '\n\n' before a paragraph, '\n' before a line, ' ' before a sentence/word, '' to glue. */
  sep: string
  weight: number
}

const MIN_CHUNK_TOKENS = 16

/*
 * Sentence boundaries: a terminator (Latin . ! ?, ellipsis, Bangla/Devanagari danda । and ॥,
 * Arabic/Urdu ؟ ۔), optionally followed by closing quotes/brackets, then whitespace. Full-width
 * CJK terminators end a sentence even without a following space (but never before a closer).
 */
const SENTENCE_BREAK =
  /(?<=[.!?…।॥؟۔][\p{Pe}\p{Pf}"'’”»]*)\s+|(?<=[。！？][\p{Pe}\p{Pf}"'’”」』]*)(?![\p{Pe}\p{Pf}"'’”」』])\s*/u
const PARAGRAPH_BREAK = /\n[^\S\n]*\n\s*/
const WHITESPACE_RUN = /\s+/u
const WHITESPACE_CHAR = /\s/u

/**
 * Splits text into overlapping chunks of at most `chunkTokens` estimated tokens.
 *
 * Text is split into paragraphs → lines → sentences (Unicode-aware, incl. the Bangla danda "।"),
 * and whole sentences are packed into each chunk. A sentence too long to fit is split into
 * words. Each new chunk starts with the tail of the previous one (~`overlapTokens`, starting at a
 * word boundary) so facts that straddle a boundary stay retrievable. Words are never cut, except a
 * single "word" longer than a whole chunk (e.g. a pasted base64 blob), which is split by
 * characters as a last resort. Never returns empty chunks.
 */
export function chunkText(text: string, opts: ChunkOptions = {}): string[] {
  const budget = Math.max(
    MIN_CHUNK_TOKENS,
    finiteOr(opts.chunkTokens, KNOWLEDGE_LIMITS.chunkTokens),
  )
  const overlap = Math.min(
    Math.max(0, finiteOr(opts.overlapTokens, KNOWLEDGE_LIMITS.chunkOverlapTokens)),
    Math.floor(budget / 2),
  )
  // Units must leave room for the overlap (and one separator) so overlap + unit always fits.
  const maxUnit = Math.max(1, budget - overlap - 1)

  const chunks: string[] = []
  let current = ''
  let weight = 0
  // True once the current chunk holds something beyond the copied overlap.
  let hasNew = false

  for (const unit of toUnits(text, maxUnit)) {
    let sep = current ? unit.sep : ''
    if (hasNew && weight + tokenWeight(sep) + unit.weight > budget) {
      chunks.push(current)
      current = overlapTail(current, overlap)
      weight = tokenWeight(current)
      hasNew = false
      sep = current ? unit.sep : ''
    }
    current += sep + unit.text
    weight += tokenWeight(sep) + unit.weight
    hasNew = true
  }
  if (hasNew) chunks.push(current)

  return chunks.map((c) => c.trim()).filter((c) => c.length > 0)
}

function finiteOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.floor(value) : fallback
}

function toUnits(text: string, maxUnit: number): Unit[] {
  const units: Unit[] = []
  const paragraphs = text.replace(/\r\n?/g, '\n').split(PARAGRAPH_BREAK)
  let firstParagraph = true
  for (const paragraph of paragraphs) {
    let lineIdx = 0
    for (const rawLine of paragraph.split('\n')) {
      const sentences = splitSentences(rawLine)
      if (!sentences.length) continue
      sentences.forEach((sentence, i) => {
        const sep = i > 0 ? ' ' : lineIdx > 0 ? '\n' : firstParagraph ? '' : '\n\n'
        pushSentence(units, sentence, sep, maxUnit)
      })
      lineIdx++
    }
    if (lineIdx > 0) firstParagraph = false
  }
  return units
}

/** Splits one line into trimmed, non-empty sentences. */
export function splitSentences(line: string): string[] {
  return line
    .split(SENTENCE_BREAK)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

function pushSentence(units: Unit[], sentence: string, sep: string, maxUnit: number): void {
  const weight = tokenWeight(sentence)
  if (weight <= maxUnit) {
    units.push({ text: sentence, sep, weight })
    return
  }
  const words = sentence.split(WHITESPACE_RUN).filter((w) => w.length > 0)
  words.forEach((word, i) => {
    const wordSep = i === 0 ? sep : ' '
    const w = tokenWeight(word)
    if (w <= maxUnit) {
      units.push({ text: word, sep: wordSep, weight: w })
      return
    }
    hardSplit(word, maxUnit).forEach((piece, j) => {
      units.push({ text: piece, sep: j === 0 ? wordSep : '', weight: tokenWeight(piece) })
    })
  })
}

/** Last resort for a single word longer than a chunk: split by code points. */
function hardSplit(word: string, maxUnit: number): string[] {
  const pieces: string[] = []
  let piece = ''
  let weight = 0
  for (const ch of word) {
    const w = tokenWeight(ch)
    if (piece && weight + w > maxUnit) {
      pieces.push(piece)
      piece = ''
      weight = 0
    }
    piece += ch
    weight += w
  }
  if (piece) pieces.push(piece)
  return pieces
}

/**
 * The longest suffix of `chunk` that starts at a word boundary and weighs at most `overlap`
 * tokens. Never the whole chunk, so every chunk adds new text.
 */
function overlapTail(chunk: string, overlap: number): string {
  if (overlap <= 0) return ''
  let weight = 0
  let start = -1
  for (let i = chunk.length - 1; i > 0; i--) {
    weight += codeUnitWeight(chunk.charCodeAt(i))
    if (weight > overlap) break
    if (isSpace(chunk[i - 1]) && !isSpace(chunk[i])) start = i
  }
  return start > 0 ? chunk.slice(start) : ''
}

function isSpace(ch: string | undefined): boolean {
  return ch !== undefined && WHITESPACE_CHAR.test(ch)
}
