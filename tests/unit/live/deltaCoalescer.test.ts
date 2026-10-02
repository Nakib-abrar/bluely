import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeltaCoalescer } from '@main/live/deltaCoalescer'

describe('DeltaCoalescer', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('batches deltas per card within the interval', () => {
    const sent: [string, string][] = []
    const c = new DeltaCoalescer((id, d) => sent.push([id, d]), 30)
    c.push('a', 'Hel')
    c.push('a', 'lo')
    c.push('b', 'Hi')
    expect(sent).toEqual([])
    vi.advanceTimersByTime(30)
    expect(sent).toEqual([
      ['a', 'Hello'],
      ['b', 'Hi'],
    ])
  })

  it('flushes a single card immediately (before done/error)', () => {
    const sent: [string, string][] = []
    const c = new DeltaCoalescer((id, d) => sent.push([id, d]), 30)
    c.push('a', 'x')
    c.push('b', 'y')
    c.flush('a')
    expect(sent).toEqual([['a', 'x']])
    vi.advanceTimersByTime(30)
    expect(sent).toEqual([
      ['a', 'x'],
      ['b', 'y'],
    ])
  })
})
