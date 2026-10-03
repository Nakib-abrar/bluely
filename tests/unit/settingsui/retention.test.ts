import { describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@shared/types'
import {
  DAY_MS,
  SESSIONS_PAGE,
  countSessionsBefore,
  isShorterRetention,
  retentionCutoff,
} from '@renderer/settings/lib/retention'

const NOW = Date.UTC(2026, 9, 3)

function session(id: string, startedAt: number, status: SessionSummary['status'] = 'done') {
  return {
    id,
    title: id,
    modeId: null,
    startedAt,
    endedAt: null,
    durationMs: null,
    status,
  } satisfies SessionSummary
}

/** Behaves like main's 'sessions:list': newest first, started_at < before, at most `limit`. */
function fakeList(all: SessionSummary[]) {
  const sorted = [...all].sort((a, b) => b.startedAt - a.startedAt)
  return vi.fn(async (before: number, limit: number) =>
    sorted.filter((s) => s.startedAt < before).slice(0, limit),
  )
}

describe('retention preview', () => {
  it('only asks when the new value keeps less history', () => {
    expect(isShorterRetention(0, 30)).toBe(true) // forever → 30 days
    expect(isShorterRetention(365, 90)).toBe(true)
    expect(isShorterRetention(30, 90)).toBe(false)
    expect(isShorterRetention(90, 0)).toBe(false) // → forever deletes nothing
    expect(isShorterRetention(90, 90)).toBe(false)
  })

  it('uses the same cutoff as main', () => {
    expect(retentionCutoff(30, NOW)).toBe(NOW - 30 * DAY_MS)
  })

  it('counts finished meetings older than the cutoff, never the live one', async () => {
    const cutoff = retentionCutoff(30, NOW)
    const list = fakeList([
      session('recent', NOW - 2 * DAY_MS),
      session('old-1', NOW - 40 * DAY_MS),
      session('old-2', NOW - 400 * DAY_MS, 'failed'),
      session('live', NOW - 45 * DAY_MS, 'active'),
    ])
    expect(await countSessionsBefore(cutoff, list)).toBe(2)
    expect(list).toHaveBeenCalledWith(cutoff, SESSIONS_PAGE)
  })

  it('pages through long histories, including sessions sharing a start time', async () => {
    const cutoff = retentionCutoff(30, NOW)
    const old: SessionSummary[] = []
    for (let i = 0; i < 1234; i++) {
      // Pairs share a millisecond so page boundaries fall between equal start times.
      old.push(session(`s${i}`, cutoff - 1 - Math.floor(i / 2) * 1000))
    }
    const list = fakeList([...old, session('new', NOW)])
    expect(await countSessionsBefore(cutoff, list)).toBe(1234)
    expect(list.mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it('returns 0 when nothing is old enough', async () => {
    const list = fakeList([session('recent', NOW - DAY_MS)])
    expect(await countSessionsBefore(retentionCutoff(30, NOW), list)).toBe(0)
  })
})
