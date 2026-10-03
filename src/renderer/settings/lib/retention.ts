/**
 * Preview of what a new "Keep sessions" value would delete, so Settings › Privacy can ask before
 * main's retention run removes meetings (it runs as soon as the setting changes, and cannot be
 * undone). Pure apart from the injected session lister (unit-tested in tests/unit/settingsui).
 */
import type { Settings } from '@shared/settings'
import type { SessionSummary } from '@shared/types'

export type RetentionDays = Settings['privacy']['retentionDays']

export const DAY_MS = 24 * 60 * 60 * 1000

/** Largest page 'sessions:list' serves. */
export const SESSIONS_PAGE = 500

/** True when `next` keeps less history than `current` (0 means forever). */
export function isShorterRetention(current: RetentionDays, next: RetentionDays): boolean {
  if (next <= 0) return false
  return current <= 0 || next < current
}

/** Sessions started before this time are deleted by a retention of `days` (same rule as main). */
export function retentionCutoff(days: RetentionDays, nowMs: number): number {
  return nowMs - days * DAY_MS
}

/**
 * Counts the meetings main's retention would delete for `cutoff`: every session that started
 * before it and is not the live one. Pages through 'sessions:list' (newest first, started_at <
 * before), so the count is exact however long the history is. Returns null when it cannot be
 * exact: more than a full page of sessions share one start time, so paging by time cannot reach
 * the rest of them (the caller then asks without a number rather than with a low one).
 */
export async function countSessionsBefore(
  cutoff: number,
  list: (before: number, limit: number) => Promise<SessionSummary[]>,
): Promise<number | null> {
  const seen = new Set<string>()
  let count = 0
  let before = cutoff
  for (;;) {
    const page = await list(before, SESSIONS_PAGE)
    let added = 0
    for (const s of page) {
      if (seen.has(s.id)) continue
      seen.add(s.id)
      added++
      if (s.startedAt < cutoff && s.status !== 'active') count++
    }
    const last = page[page.length - 1]
    if (!last || page.length < SESSIONS_PAGE) return count
    // A full page with nothing new: it is all one start time and more may follow it unseen.
    if (added === 0) return null
    // +1 re-reads sessions that share the last start time (the list is strictly "before");
    // `seen` skips the ones already counted.
    before = Math.min(cutoff, last.startedAt + 1)
  }
}
