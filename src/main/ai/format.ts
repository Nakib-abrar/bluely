import type { Channel, TranscriptLine } from '@shared/types'

/** Speaker labels used inside prompts (the model is told what they mean; never translated). */
export const PROMPT_SPEAKER: Record<Channel, string> = { me: 'Me', them: 'Them' }

/** Consecutive same-speaker lines closer than this are merged into one block. */
export const MERGE_GAP_MS = 30_000

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** Session offset → "04:05" (or "1:02:03" past the first hour). */
export function formatTimestamp(ms: number): string {
  const total = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`
}

/** Duration → "32:05" (or "1:29:35"), matching the session list badge. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '0:00'
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`
}

/** Epoch ms → "Mar 4, 2026, 2:05 PM" in the machine's time zone. */
export function formatDateTime(epochMs: number, locale = 'en-US'): string {
  return new Date(epochMs).toLocaleString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

/** Final, non-empty lines in time order (input order breaks ties). */
export function usableLines(lines: readonly TranscriptLine[]): TranscriptLine[] {
  return lines
    .filter((l) => l.isFinal && l.text.trim().length > 0)
    .map((l, i) => ({ l, i }))
    .sort((a, b) => a.l.startMs - b.l.startMs || a.i - b.i)
    .map(({ l }) => l)
}

/** A run of consecutive lines from one speaker. */
export interface TranscriptBlock {
  channel: Channel
  startMs: number
  endMs: number
  text: string
  lineCount: number
}

/**
 * Merges consecutive same-speaker lines (VAD cuts long turns into many short segments) so the
 * prompt reads like a conversation and spends fewer tokens on repeated labels.
 */
export function mergeTranscriptLines(
  lines: readonly TranscriptLine[],
  maxGapMs = MERGE_GAP_MS,
): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = []
  for (const line of lines) {
    const text = line.text.replace(/\s+/g, ' ').trim()
    if (!text) continue
    const prev = blocks[blocks.length - 1]
    if (prev && prev.channel === line.channel && line.startMs - prev.endMs <= maxGapMs) {
      prev.text = `${prev.text} ${text}`
      prev.endMs = Math.max(prev.endMs, line.endMs)
      prev.lineCount++
    } else {
      blocks.push({
        channel: line.channel,
        startMs: line.startMs,
        endMs: line.endMs,
        text,
        lineCount: 1,
      })
    }
  }
  return blocks
}

/**
 * Transcript as prompt text: one `[mm:ss] Me: …` / `[mm:ss] Them: …` line per merged block.
 * Also the format post-call generation expects for `transcriptText`.
 */
export function formatTranscript(lines: readonly TranscriptLine[]): string {
  return mergeTranscriptLines(usableLines(lines))
    .map((b) => `[${formatTimestamp(b.startMs)}] ${PROMPT_SPEAKER[b.channel]}: ${b.text}`)
    .join('\n')
}
