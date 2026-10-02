import { dayKey, formatDay } from '../../lib/format'

export interface DayGroup<T> {
  key: string
  label: string
  items: T[]
}

/**
 * Groups items (already sorted newest first) by local calendar day, preserving order.
 * Items from the same day that are not adjacent still land in one group.
 */
export function groupByDay<T extends { startedAt: number }>(
  items: readonly T[],
  now = Date.now(),
): DayGroup<T>[] {
  const groups: DayGroup<T>[] = []
  const byKey = new Map<string, DayGroup<T>>()
  for (const item of items) {
    const key = dayKey(item.startedAt)
    let group = byKey.get(key)
    if (!group) {
      group = { key, label: formatDay(item.startedAt, now), items: [] }
      byKey.set(key, group)
      groups.push(group)
    }
    group.items.push(item)
  }
  return groups
}

/** Merges a fetched page into the loaded list (dedupe by id, newest first). */
export function mergeSessions<T extends { id: string; startedAt: number }>(
  current: readonly T[],
  page: readonly T[],
): T[] {
  const map = new Map<string, T>()
  for (const s of current) map.set(s.id, s)
  for (const s of page) map.set(s.id, s)
  return [...map.values()].sort((a, b) => b.startedAt - a.startedAt)
}
