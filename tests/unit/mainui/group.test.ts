import { describe, expect, it } from 'vitest'
import { groupByDay, mergeSessions } from '@renderer/main/lib/group'

function at(y: number, mo: number, d: number, h: number): number {
  return new Date(y, mo - 1, d, h, 0, 0, 0).getTime()
}

describe('groupByDay', () => {
  const now = at(2026, 1, 12, 12)

  it('groups by local day, newest first, with formatted labels', () => {
    const items = [
      { id: 'a', startedAt: at(2026, 1, 10, 23) },
      { id: 'b', startedAt: at(2026, 1, 10, 1) },
      { id: 'c', startedAt: at(2026, 1, 2, 3) },
    ]
    const groups = groupByDay(items, now)
    expect(groups.map((g) => g.label)).toEqual(['Sat, Jan 10', 'Fri, Jan 2'])
    expect(groups[0]?.items.map((i) => i.id)).toEqual(['a', 'b'])
  })

  it('adds the year for other years and merges non-adjacent items of one day', () => {
    const items = [
      { id: 'a', startedAt: at(2026, 1, 10, 9) },
      { id: 'b', startedAt: at(2025, 12, 29, 9) },
      { id: 'c', startedAt: at(2026, 1, 10, 8) },
    ]
    const groups = groupByDay(items, now)
    expect(groups).toHaveLength(2)
    expect(groups[0]?.items.map((i) => i.id)).toEqual(['a', 'c'])
    expect(groups[1]?.label).toBe('Mon, Dec 29, 2025')
  })
})

describe('mergeSessions', () => {
  it('dedupes by id (page wins) and sorts newest first', () => {
    const merged = mergeSessions(
      [
        { id: 'a', startedAt: 3, title: 'old' },
        { id: 'b', startedAt: 2, title: 'b' },
      ],
      [
        { id: 'a', startedAt: 3, title: 'new' },
        { id: 'c', startedAt: 1, title: 'c' },
      ],
    )
    expect(merged.map((s) => `${s.id}:${s.title}`)).toEqual(['a:new', 'b:b', 'c:c'])
  })
})
