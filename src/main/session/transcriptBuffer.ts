/**
 * In-memory transcript of the live session, kept sorted for prompt building and the overlay.
 * Lines are ordered by startMs; on ties "them" sorts before "me" (the question comes before the
 * answer when both channels start in the same millisecond), then by arrival.
 */
import type { Channel, TranscriptLine } from '@shared/types'

export type UpsertResult = 'inserted' | 'updated'

export interface TranscriptFormatOptions {
  /** Prefix each speaker turn with "[mm:ss]" (or "[h:mm:ss]" past the first hour). */
  timestamps?: boolean
  /** Speaker labels. Defaults to "Me" / "Them", which prompts rely on, so only override for display. */
  labels?: Partial<Record<Channel, string>>
}

type FormattableLine = Pick<TranscriptLine, 'channel' | 'startMs' | 'text'>

const CHANNEL_RANK: Record<Channel, number> = { them: 0, me: 1 }
const DEFAULT_LABELS: Record<Channel, string> = { me: 'Me', them: 'Them' }

function compare(a: TranscriptLine, b: TranscriptLine): number {
  return a.startMs - b.startMs || CHANNEL_RANK[a.channel] - CHANNEL_RANK[b.channel]
}

/** 83_000 → "01:23", 3_723_000 → "1:02:03". Negative or invalid input reads as 0. */
export function formatTimestamp(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = String(s).padStart(2, '0')
  const mm = String(m).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

export class TranscriptBuffer {
  private lines: TranscriptLine[] = []
  private byId = new Map<string, TranscriptLine>()

  get size(): number {
    return this.lines.length
  }

  /**
   * Inserts a line or replaces the line with the same id (partial → final). A late partial never
   * overwrites a line that is already final.
   */
  upsert(line: TranscriptLine): UpsertResult {
    const existing = this.byId.get(line.id)
    if (existing) {
      if (existing.isFinal && !line.isFinal) return 'updated'
      const next = { ...line }
      const idx = this.indexOf(existing)
      if (compare(existing, next) === 0) {
        this.lines[idx] = next
      } else {
        this.lines.splice(idx, 1)
        this.insertSorted(next)
      }
      this.byId.set(next.id, next)
      return 'updated'
    }
    const copy = { ...line }
    this.insertSorted(copy)
    this.byId.set(copy.id, copy)
    return 'inserted'
  }

  /** Removes a line (e.g. an echo retracted by the de-duplicator). */
  remove(id: string): boolean {
    const existing = this.byId.get(id)
    if (!existing) return false
    this.lines.splice(this.indexOf(existing), 1)
    this.byId.delete(id)
    return true
  }

  get(id: string): TranscriptLine | undefined {
    return this.byId.get(id)
  }

  all(): TranscriptLine[] {
    return [...this.lines]
  }

  finals(): TranscriptLine[] {
    return this.lines.filter((l) => l.isFinal)
  }

  /** Lines that started at or after `ms`. */
  since(ms: number): TranscriptLine[] {
    return this.lines.slice(this.lowerBound(ms))
  }

  /** Lines that started in [a, b): `between(a, b)` plus `since(b)` equals `since(a)`. */
  between(a: number, b: number): TranscriptLine[] {
    if (b <= a) return []
    return this.lines.slice(this.lowerBound(a), this.lowerBound(b))
  }

  /** The last `n` lines of one channel, oldest first. */
  lastOfChannel(channel: Channel, n = 1): TranscriptLine[] {
    const out: TranscriptLine[] = []
    for (let i = this.lines.length - 1; i >= 0 && out.length < n; i--) {
      const l = this.lines[i] as TranscriptLine
      if (l.channel === channel) out.push(l)
    }
    return out.reverse()
  }

  /**
   * Lines overlapping the last `windowMs` before `nowMs` (a long line that started earlier but
   * is still running counts), for "recent context" prompts.
   */
  recent(windowMs: number, nowMs: number): TranscriptLine[] {
    const from = nowMs - windowMs
    return this.lines.filter((l) => l.endMs >= from && l.startMs <= nowMs)
  }

  /** End of the latest line, i.e. how much of the session the transcript covers. */
  durationMs(): number {
    let max = 0
    for (const l of this.lines) if (l.endMs > max) max = l.endMs
    return max
  }

  clear(): void {
    this.lines = []
    this.byId.clear()
  }

  /**
   * Renders lines as "Me: …" / "Them: …", one speaker turn per line; consecutive lines from the
   * same speaker are merged. Lines are rendered in the order given; blank lines are skipped.
   */
  static format(lines: readonly FormattableLine[], opts: TranscriptFormatOptions = {}): string {
    const labels = { ...DEFAULT_LABELS, ...opts.labels }
    const out: string[] = []
    let turn: { channel: Channel; startMs: number; parts: string[] } | null = null
    const flush = () => {
      if (!turn) return
      const stamp = opts.timestamps ? `[${formatTimestamp(turn.startMs)}] ` : ''
      out.push(`${stamp}${labels[turn.channel]}: ${turn.parts.join(' ')}`)
    }
    for (const line of lines) {
      const text = line.text.replace(/\s+/g, ' ').trim()
      if (!text) continue
      if (turn && turn.channel === line.channel) {
        turn.parts.push(text)
        continue
      }
      flush()
      turn = { channel: line.channel, startMs: line.startMs, parts: [text] }
    }
    flush()
    return out.join('\n')
  }

  /** First index whose startMs ≥ ms. */
  private lowerBound(ms: number): number {
    let lo = 0
    let hi = this.lines.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if ((this.lines[mid] as TranscriptLine).startMs < ms) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  /** Index after every line that sorts ≤ `line` (keeps arrival order among equal keys). */
  private upperBound(line: TranscriptLine): number {
    let lo = 0
    let hi = this.lines.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (compare(this.lines[mid] as TranscriptLine, line) <= 0) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  private insertSorted(line: TranscriptLine): void {
    const last = this.lines[this.lines.length - 1]
    // Lines almost always arrive in order: append without searching.
    if (!last || compare(last, line) <= 0) this.lines.push(line)
    else this.lines.splice(this.upperBound(line), 0, line)
  }

  private indexOf(line: TranscriptLine): number {
    // Search among equal keys first; fall back to a scan (should never be needed).
    let i = this.upperBound(line) - 1
    while (i >= 0 && compare(this.lines[i] as TranscriptLine, line) === 0) {
      if (this.lines[i] === line) return i
      i--
    }
    return this.lines.indexOf(line)
  }
}
