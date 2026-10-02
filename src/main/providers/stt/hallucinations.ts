/**
 * Whisper-family models invent text for silence, music and noise ("Thank you.", "Thanks for
 * watching!", "[Music]", credit lines, word loops). This filter drops those lines.
 *
 * It is deliberately conservative: a short pleasantry is only treated as invented when the
 * audio was quiet or suspiciously long for it, so real speech such as "Thank you, that's very
 * helpful for us" or a one-second "Yes." always survives.
 */

export interface HallucinationContext {
  /** Duration of the audio that produced the text, in seconds. */
  durationSec: number
  /** Mean RMS level of that audio (0..1), or null when unknown. */
  rms: number | null
}

/** Mean RMS below which a lone filler phrase is treated as invented (≈ -44 dBFS). */
export const QUIET_RMS = 0.006
/**
 * A segment this long whose whole transcript is one filler phrase is almost always music or
 * noise (VAD kept "hearing speech" for seconds, the model found only "Thank you.").
 */
export const LONG_FILLER_SEGMENT_SEC = 8
/** Above this many words per second of audio the text cannot all have been spoken. */
const MAX_WORDS_PER_SEC = 9
/** Same idea for scripts without spaces (CJK): letters per second. */
const MAX_LETTERS_PER_SEC = 45

/**
 * Trims, removes zero-width characters, collapses whitespace and strips subtitle-style
 * speaker markers at the start ("- ", ">>").
 */
export function cleanTranscript(text: string): string {
  return text
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:>>+\s*|[-–—]\s+)+/, '')
    .trim()
}

/** True when the text contains at least one letter or digit (not just punctuation or ♪). */
export function hasSpeechContent(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text)
}

/** Lower-cased word tokens. Keeps inner apostrophes/dots ("don't", "amara.org"); marks stay
 * attached so Bangla/Devanagari words are not split at vowel signs. */
function words(text: string): string[] {
  return (
    text
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[’‘ʼ`´]/g, "'")
      .match(/[\p{L}\p{M}\p{N}]+(?:['.][\p{L}\p{M}\p{N}]+)*/gu) ?? []
  )
}

// Bracketed or starred sound tags: [Music], (upbeat music), *applause*, ♪ la la ♪, 【音楽】.
const SOUND_TAG = /\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|♪[^♪]*♪|【[^】]*】|[♪♫♬🎵🎶]/gu

/** Whole-line YouTube-isms. Matched as word sequences. */
const STRONG_PHRASES = [
  'thanks for watching',
  'thank you for watching',
  'thanks so much for watching',
  'thank you so much for watching',
  'thank you very much for watching',
  'thank you all for watching',
  'please subscribe',
  'subscribe to my channel',
  'subscribe to the channel',
  'subscribe to our channel',
  'like and subscribe',
  "don't forget to subscribe",
  "don't forget to like and subscribe",
  'like comment and subscribe',
  'see you in the next video',
  "i'll see you in the next video",
  'ご視聴ありがとうございました',
  'продолжение следует',
]

/** Words allowed to remain next to a strong phrase ("Thanks for watching! Bye, see you…"). */
const CLOSER_WORDS = new Set(
  (
    'a again all and bell bye channel comment everyone for forget goodbye guys hit in like much ' +
    'my next notification one our please see share so soon subscribe take care thank thanks ' +
    "the this time to very video watching you don't oh uh um"
  ).split(' '),
)

/** Short phrases Whisper emits for silence/noise; only dropped with quiet or long audio. */
const FILLER_PHRASES = new Set([
  'you',
  'thank you',
  'thank you very much',
  'thank you so much',
  'thank you all',
  'thank you everyone',
  'thanks',
  'thanks a lot',
  'bye',
  'bye bye',
  'goodbye',
  'so',
  'oh',
  'the',
  'i',
  'and',
  'the end',
  'music',
  'applause',
  'laughter',
  'silence',
  'noise',
  'gracias',
  'merci',
  'danke',
  'grazie',
  'obrigado',
  'спасибо',
  '谢谢',
  'ありがとうございました',
  '감사합니다',
  'ধন্যবাদ',
])

/** Hesitation sounds: uh, umm, hmm, mm-hmm, ah, oh, er(m), huh. */
const FILLER_SOUND = /^(?:u+h*|u+m+|h*m+|m+h+m+|a+h+|o+h+|e+r+m*|h+u+h+)$/

// Credit lines that Whisper learned from subtitle files.
const CREDIT_START =
  /^(?:subtitles?|subtitled|captions?|captioned|captioning|closed captions?|closed captioning)\s+(?:by|from|provided by|created by)\b/
const FOREIGN_CREDIT_START =
  /^(?:untertitel|untertitelung|sottotitoli|sous-titres|sous-titrage|subtítulos|subtitulado|legendas|ondertiteling|ondertitels|napisy|субтитры|字幕)/

function isCreditLine(lower: string, wordCount: number): boolean {
  if (lower.includes('amara.org')) return true
  if (/^transcription by castingwords/.test(lower)) return true
  if (wordCount <= 10 && (CREDIT_START.test(lower) || FOREIGN_CREDIT_START.test(lower))) {
    return true
  }
  return false
}

/** True when the remaining words, after removing strong phrases, are only sign-off filler. */
function isStrongPhraseLine(tokens: string[]): boolean {
  let joined = ` ${tokens.join(' ')} `
  let found = false
  for (const phrase of STRONG_PHRASES) {
    const needle = ` ${phrase} `
    while (joined.includes(needle)) {
      joined = joined.replace(needle, ' ')
      found = true
    }
  }
  if (!found) return false
  return joined
    .trim()
    .split(' ')
    .filter(Boolean)
    .every((w) => CLOSER_WORDS.has(w) || FILLER_SOUND.test(w))
}

/** Smallest n-gram length p such that `tokens` is that n-gram repeated (≥ 2 full times). */
function exactPeriod(tokens: string[]): number | null {
  const n = tokens.length
  for (let p = 1; p * 2 <= n; p++) {
    if (n % p !== 0) continue
    let ok = true
    for (let i = p; i < n && ok; i++) ok = tokens[i] === tokens[i - p]
    if (ok) return p
  }
  return null
}

/** The phrase with immediate repeats collapsed ("thank you thank you" → "thank you"). */
function collapseRepeats(tokens: string[]): string {
  const p = exactPeriod(tokens)
  return (p ? tokens.slice(0, p) : tokens).join(' ')
}

function isFillerOnly(tokens: string[]): boolean {
  if (tokens.length === 0) return false
  if (FILLER_PHRASES.has(collapseRepeats(tokens))) return true
  return tokens.every((w) => FILLER_SOUND.test(w))
}

/**
 * Detects decoding loops: the same word ≥ 5 times in a row, or the same 2–8 word phrase
 * ≥ 4 times in a row, covering at least 80% of the text. Real speech with some emphasis
 * ("no no no, that's not what I meant") stays below that coverage.
 */
function isRepetitionLoop(tokens: string[]): boolean {
  const n = tokens.length
  if (n < 5) return false
  for (let p = 1; p <= 8 && p * 4 <= n; p++) {
    const minRepeats = p === 1 ? 5 : 4
    for (let start = 0; start + p * minRepeats <= n; start++) {
      let repeats = 1
      while (start + (repeats + 1) * p <= n) {
        let same = true
        for (let k = 0; k < p && same; k++) {
          same = tokens[start + repeats * p + k] === tokens[start + k]
        }
        if (!same) break
        repeats++
      }
      if (repeats >= minRepeats && (repeats * p) / n >= 0.8) return true
    }
  }
  return false
}

/**
 * A single letter stretched out ("aaaa", "i i i", "mmmmm") or a lone word with a 6+ letter
 * run ("ooooooh"). Digits never count, so "111" or "1000000" survive.
 */
function isStretchedSound(tokens: string[]): boolean {
  const joined = tokens.join('')
  if (/\p{N}/u.test(joined)) return false
  if (joined.length >= 3 && new Set(joined).size === 1) return true
  return tokens.length === 1 && /(\p{L})\1{5,}/u.test(joined)
}

function isImplausiblyFast(tokens: string[], durationSec: number): boolean {
  if (!(durationSec > 0) || !Number.isFinite(durationSec)) return false
  const wordCount = tokens.length
  if (wordCount >= 5 && wordCount > durationSec * MAX_WORDS_PER_SEC) return true
  const letters = tokens.join('').length
  return letters >= 30 && letters > durationSec * MAX_LETTERS_PER_SEC
}

/**
 * True when `text` (a single segment's transcript) is most likely invented by the model
 * rather than spoken. Empty text returns false: callers treat it as "no speech" separately.
 */
export function isLikelyHallucination(text: string, ctx: HallucinationContext): boolean {
  const cleaned = cleanTranscript(text)
  if (cleaned === '') return false
  if (!hasSpeechContent(cleaned)) return true

  const lower = cleaned.normalize('NFKC').toLowerCase()
  const tokens = words(cleaned)
  if (isCreditLine(lower, tokens.length)) return true

  // Only sound tags such as "[Music]" or "(upbeat music)".
  if (!hasSpeechContent(cleaned.replace(SOUND_TAG, ' '))) return true

  if (tokens.length === 0) return false
  if (isStrongPhraseLine(tokens)) return true
  if (isRepetitionLoop(tokens) || isStretchedSound(tokens)) return true

  if (isFillerOnly(tokens)) {
    const quiet = ctx.rms != null && Number.isFinite(ctx.rms) && ctx.rms < QUIET_RMS
    if (quiet || ctx.durationSec >= LONG_FILLER_SEGMENT_SEC) return true
  }

  return isImplausiblyFast(tokens, ctx.durationSec)
}
