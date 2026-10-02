/**
 * Echo de-duplication. When the user is on speakers, the microphone also picks up the other
 * side, so the same words arrive twice: once on "Them" (loopback) and once on "Me" (mic).
 * The Me copy is dropped when it is ≥ 80 % similar to a Them line within ±3 s.
 *
 * The two channels are transcribed independently, so either copy can be finalized first:
 * `checkMe` handles "Them arrived first" and `checkThem` returns Me lines to retract when the
 * Them line arrives later.
 */
import { AUDIO } from '@shared/constants'
import type { TranscriptLine } from '@shared/types'

/** Lower-case, strip punctuation and symbols (Unicode-aware), collapse whitespace. */
export function normalizeForComparison(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/['\u2019\u02BC]/g, '')
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function wordBigrams(words: readonly string[]): string[] {
  const out: string[] = []
  for (let i = 0; i + 1 < words.length; i++) out.push(`${words[i]} ${words[i + 1]}`)
  return out
}

function charTrigrams(text: string): string[] {
  // Code points, not UTF-16 units, so emoji and astral scripts never split mid-character.
  const chars = Array.from(` ${text} `)
  const out: string[] = []
  for (let i = 0; i + 2 < chars.length; i++) out.push(`${chars[i]}${chars[i + 1]}${chars[i + 2]}`)
  return out
}

/** Word bigrams normally; character trigrams for short strings (< 4 words), where bigrams are too coarse. */
function shingles(normalized: string, useChars: boolean): string[] {
  return useChars ? charTrigrams(normalized) : wordBigrams(normalized.split(' '))
}

function countMap(items: readonly string[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const it of items) m.set(it, (m.get(it) ?? 0) + 1)
  return m
}

function overlap(a: readonly string[], b: readonly string[]): number {
  const counts = countMap(b)
  let shared = 0
  for (const it of a) {
    const c = counts.get(it) ?? 0
    if (c > 0) {
      shared++
      counts.set(it, c - 1)
    }
  }
  return shared
}

function wordCount(normalized: string): number {
  return normalized ? normalized.split(' ').length : 0
}

function similarityNormalized(na: string, nb: string): number {
  if (na === nb) return 1
  if (!na || !nb) return 0
  const useChars = wordCount(na) < 4 || wordCount(nb) < 4
  const a = shingles(na, useChars)
  const b = shingles(nb, useChars)
  if (a.length + b.length === 0) return 0
  return (2 * overlap(a, b)) / (a.length + b.length)
}

/**
 * Sørensen–Dice similarity (0..1) of two transcript strings after normalization: word bigrams,
 * or character trigrams when either side has fewer than 4 words. Identical strings → 1.
 */
export function similarity(a: string, b: string): number {
  return similarityNormalized(normalizeForComparison(a), normalizeForComparison(b))
}

function containmentNormalized(part: string, whole: string): number {
  if (!part || !whole) return 0
  if (part === whole) return 1
  const useChars = wordCount(part) < 4 || wordCount(whole) < 4
  const a = shingles(part, useChars)
  if (a.length === 0) return 0
  return overlap(a, shingles(whole, useChars)) / a.length
}

/**
 * Share (0..1) of `part`'s shingles that also occur in `whole`. Catches an echo that is only a
 * fragment of a longer line because the two channels' voice detection cut segments differently.
 */
export function containment(part: string, whole: string): number {
  return containmentNormalized(normalizeForComparison(part), normalizeForComparison(whole))
}

export interface EchoDeduperOptions {
  /** A Them line counts when its [start, end] lies within ±windowMs of the Me line. */
  windowMs?: number
  /** Similarity at or above which a Me line is an echo. */
  threshold?: number
  /** Lines older than this (relative to the newest line seen) are forgotten. */
  historyMs?: number
  /** Hard cap on remembered lines per channel. */
  maxLines?: number
  /** Fragment matching (containment) only applies to Me lines with at least this many words. */
  minFragmentWords?: number
}

export interface EchoCheck {
  drop: boolean
  /** The Them line the Me line echoed. */
  matchedId: string | null
}

type DedupLine = Pick<TranscriptLine, 'id' | 'startMs' | 'endMs' | 'text'>

interface Entry {
  id: string
  startMs: number
  endMs: number
  norm: string
  words: number
}

/** Echo audio is simultaneous with its source; allow for each channel's VAD padding. */
const OVERLAP_SLACK_MS = 250
const MAX_COUNTED_IDS = 500

/** Detects Me lines that are the speaker echo of a Them line. Times are session-relative ms. */
export class EchoDeduper {
  private readonly windowMs: number
  private readonly threshold: number
  private readonly historyMs: number
  private readonly maxLines: number
  private readonly minFragmentWords: number
  private them: Entry[] = []
  private me: Entry[] = []
  /** Ids already counted as echoes, so a re-checked line is not counted twice. */
  private counted = new Set<string>()
  private latestMs = 0
  private echoes = 0

  constructor(opts: EchoDeduperOptions = {}) {
    this.windowMs = opts.windowMs ?? AUDIO.dedupWindowMs
    this.threshold = opts.threshold ?? AUDIO.dedupSimilarity
    this.historyMs = opts.historyMs ?? 60_000
    this.maxLines = opts.maxLines ?? 200
    this.minFragmentWords = opts.minFragmentWords ?? 4
  }

  /** Me lines dropped or retracted as echoes since the last reset (drives the one-time headphones tip). */
  get echoCount(): number {
    return this.echoes
  }

  /** Lines currently remembered per channel (for tests and diagnostics). */
  get historySize(): { me: number; them: number } {
    return { me: this.me.length, them: this.them.length }
  }

  /** A finalized Me line: drop it when it echoes a recent Them line. */
  checkMe(line: DedupLine): EchoCheck {
    const entry = toEntry(line)
    this.advance(entry.endMs)
    this.me = this.me.filter((e) => e.id !== entry.id)
    if (!entry.norm) return { drop: false, matchedId: null }
    const matchedId = this.findEcho(entry)
    if (matchedId) this.countEcho(entry.id)
    else this.me.push(entry)
    this.prune()
    return { drop: matchedId !== null, matchedId }
  }

  /** A finalized Them line: returns ids of earlier-accepted Me lines that turn out to be its echo. */
  checkThem(line: DedupLine): string[] {
    const entry = toEntry(line)
    this.advance(entry.endMs)
    this.them = this.them.filter((e) => e.id !== entry.id)
    if (!entry.norm) return []
    this.them.push(entry)
    const retract: string[] = []
    for (const me of this.me) {
      if (!this.near(me, entry)) continue
      if (this.findEcho(me)) retract.push(me.id)
    }
    if (retract.length) {
      const ids = new Set(retract)
      this.me = this.me.filter((e) => !ids.has(e.id))
      for (const id of retract) this.countEcho(id)
    }
    this.prune()
    return retract
  }

  reset(): void {
    this.them = []
    this.me = []
    this.counted.clear()
    this.latestMs = 0
    this.echoes = 0
  }

  private near(me: Entry, them: Entry): boolean {
    return me.startMs <= them.endMs + this.windowMs && me.endMs >= them.startMs - this.windowMs
  }

  private overlapsInTime(me: Entry, them: Entry): boolean {
    return (
      me.startMs <= them.endMs + OVERLAP_SLACK_MS && me.endMs >= them.startMs - OVERLAP_SLACK_MS
    )
  }

  /** The id of the Them line `me` echoes, or null. */
  private findEcho(me: Entry): string | null {
    const candidates = this.them.filter((t) => this.near(me, t))
    if (candidates.length === 0) return null
    let bestId: string | null = null
    let bestScore = 0
    for (const t of candidates) {
      let score = similarityNormalized(me.norm, t.norm)
      // The echo may be a fragment of a longer Them line (segmentation differs per channel).
      // Require time overlap so a user quoting the other side a moment later is kept.
      if (me.words >= this.minFragmentWords && this.overlapsInTime(me, t)) {
        score = Math.max(score, containmentNormalized(me.norm, t.norm))
      }
      if (score > bestScore) {
        bestScore = score
        bestId = t.id
      }
    }
    // Or span several Them lines that the loopback channel split at a pause.
    if (bestScore < this.threshold && candidates.length > 1) {
      const ordered = [...candidates].sort((a, b) => a.startMs - b.startMs)
      const joined = ordered.map((t) => t.norm).join(' ')
      bestScore = Math.max(bestScore, similarityNormalized(me.norm, joined))
      bestId ??= (ordered[0] as Entry).id
    }
    return bestScore >= this.threshold ? bestId : null
  }

  private countEcho(id: string): void {
    if (this.counted.has(id)) return
    this.counted.add(id)
    this.echoes++
    if (this.counted.size > MAX_COUNTED_IDS) {
      const oldest = this.counted.values().next().value
      if (oldest !== undefined) this.counted.delete(oldest)
    }
  }

  private advance(ms: number): void {
    if (Number.isFinite(ms) && ms > this.latestMs) this.latestMs = ms
  }

  private prune(): void {
    const cutoff = this.latestMs - this.historyMs
    const keep = (list: Entry[]) => {
      const recent = list.filter((e) => e.endMs >= cutoff)
      return recent.length > this.maxLines ? recent.slice(recent.length - this.maxLines) : recent
    }
    this.them = keep(this.them)
    this.me = keep(this.me)
  }
}

function toEntry(line: DedupLine): Entry {
  const norm = normalizeForComparison(line.text)
  return { id: line.id, startMs: line.startMs, endMs: line.endMs, norm, words: wordCount(norm) }
}
