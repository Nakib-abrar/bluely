import { describe, expect, it } from 'vitest'
import { TranscriptBuffer, formatTimestamp } from '@main/session/transcriptBuffer'
import type { Channel, TranscriptLine } from '@shared/types'

function line(
  id: string,
  channel: Channel,
  startMs: number,
  endMs: number,
  text: string,
  isFinal = true,
): TranscriptLine {
  return { id, sessionId: 's1', channel, startMs, endMs, text, isFinal }
}

const ids = (lines: TranscriptLine[]) => lines.map((l) => l.id)

describe('TranscriptBuffer', () => {
  it('orders by startMs with them before me on ties, then by arrival', () => {
    const b = new TranscriptBuffer()
    b.upsert(line('m2', 'me', 5000, 6000, 'later'))
    b.upsert(line('t1', 'them', 1000, 2000, 'first'))
    b.upsert(line('m1', 'me', 3000, 4000, 'tie me'))
    b.upsert(line('t2', 'them', 3000, 4500, 'tie them'))
    b.upsert(line('t3', 'them', 3000, 3500, 'tie them again'))
    b.upsert(line('m3', 'me', 9000, 9500, 'last'))
    expect(ids(b.all())).toEqual(['t1', 't2', 't3', 'm1', 'm2', 'm3'])
    expect(b.size).toBe(6)
  })

  it('upserts partial → final by id and repositions when start changes', () => {
    const b = new TranscriptBuffer()
    expect(b.upsert(line('a', 'them', 1000, 1500, 'What do', false))).toBe('inserted')
    expect(b.upsert(line('b', 'me', 2000, 2500, 'Hi'))).toBe('inserted')
    expect(b.upsert(line('a', 'them', 1000, 1900, 'What do you think?', true))).toBe('updated')
    expect(b.get('a')).toMatchObject({ text: 'What do you think?', isFinal: true })
    expect(b.size).toBe(2)
    expect(ids(b.finals())).toEqual(['a', 'b'])

    // A corrected start time moves the line.
    b.upsert(line('a', 'them', 3000, 3500, 'What do you think?'))
    expect(ids(b.all())).toEqual(['b', 'a'])
  })

  it('never lets a late partial overwrite a final line', () => {
    const b = new TranscriptBuffer()
    b.upsert(line('a', 'them', 0, 1000, 'final text'))
    expect(b.upsert(line('a', 'them', 0, 800, 'stale partial', false))).toBe('updated')
    expect(b.get('a')?.text).toBe('final text')
  })

  it('stores copies so callers cannot mutate the buffer', () => {
    const b = new TranscriptBuffer()
    const l = line('a', 'me', 0, 1000, 'original')
    b.upsert(l)
    l.text = 'mutated'
    expect(b.get('a')?.text).toBe('original')
    b.all().pop()
    expect(b.size).toBe(1)
  })

  it('separates partial and final lines', () => {
    const b = new TranscriptBuffer()
    b.upsert(line('a', 'them', 0, 1000, 'done'))
    b.upsert(line('b', 'me', 500, 900, 'still talk', false))
    expect(ids(b.finals())).toEqual(['a'])
    expect(ids(b.all())).toEqual(['a', 'b'])
  })

  it('removes lines', () => {
    const b = new TranscriptBuffer()
    b.upsert(line('a', 'them', 0, 1000, 'one'))
    b.upsert(line('b', 'me', 0, 1000, 'echo'))
    b.upsert(line('c', 'them', 0, 1000, 'two'))
    expect(b.remove('b')).toBe(true)
    expect(b.remove('b')).toBe(false)
    expect(b.get('b')).toBeUndefined()
    expect(ids(b.all())).toEqual(['a', 'c'])
  })

  it('answers time-range queries', () => {
    const b = new TranscriptBuffer()
    b.upsert(line('a', 'them', 0, 4000, 'a'))
    b.upsert(line('b', 'me', 5000, 6000, 'b'))
    b.upsert(line('c', 'them', 10_000, 20_000, 'c'))
    b.upsert(line('d', 'me', 21_000, 22_000, 'd'))

    expect(ids(b.since(5000))).toEqual(['b', 'c', 'd'])
    expect(ids(b.since(5001))).toEqual(['c', 'd'])
    expect(ids(b.between(0, 10_000))).toEqual(['a', 'b'])
    expect(ids(b.between(5000, 21_000))).toEqual(['b', 'c'])
    expect(b.between(10, 10)).toEqual([])
    // recent(): overlapping the window, so the long line "c" that started earlier counts.
    expect(ids(b.recent(3000, 22_000))).toEqual(['c', 'd'])
    expect(ids(b.recent(1000, 15_000))).toEqual(['c'])
    expect(b.durationMs()).toBe(22_000)
  })

  it('returns the last n lines of a channel, oldest first', () => {
    const b = new TranscriptBuffer()
    b.upsert(line('t1', 'them', 0, 1, 'x'))
    b.upsert(line('m1', 'me', 1, 2, 'x'))
    b.upsert(line('t2', 'them', 2, 3, 'x'))
    b.upsert(line('t3', 'them', 3, 4, 'x'))
    b.upsert(line('m2', 'me', 4, 5, 'x'))
    expect(ids(b.lastOfChannel('them', 2))).toEqual(['t2', 't3'])
    expect(ids(b.lastOfChannel('them'))).toEqual(['t3'])
    expect(ids(b.lastOfChannel('me', 10))).toEqual(['m1', 'm2'])
    expect(b.lastOfChannel('me', 0)).toEqual([])
  })

  it('clears', () => {
    const b = new TranscriptBuffer()
    b.upsert(line('a', 'them', 0, 1000, 'one'))
    b.clear()
    expect(b.size).toBe(0)
    expect(b.get('a')).toBeUndefined()
    expect(b.durationMs()).toBe(0)
    expect(b.upsert(line('a', 'them', 0, 1000, 'one'))).toBe('inserted')
  })

  it('stays sorted under out-of-order arrival', () => {
    const b = new TranscriptBuffer()
    const starts = [50, 10, 30, 30, 20, 70, 0, 60, 40, 30]
    starts.forEach((s, i) => b.upsert(line(`l${i}`, i % 2 ? 'me' : 'them', s, s + 5, 'x')))
    const all = b.all()
    for (let i = 1; i < all.length; i++) {
      const prev = all[i - 1] as TranscriptLine
      const cur = all[i] as TranscriptLine
      expect(prev.startMs <= cur.startMs).toBe(true)
      if (prev.startMs === cur.startMs && prev.channel !== cur.channel) {
        expect(prev.channel).toBe('them')
      }
    }
    // Every line is still reachable for update and removal.
    for (const l of all) expect(b.remove(l.id)).toBe(true)
    expect(b.size).toBe(0)
  })
})

describe('TranscriptBuffer.format', () => {
  const lines = [
    line('1', 'them', 1_000, 2_000, 'Hi there.'),
    line('2', 'them', 2_500, 4_000, '  How are   you? '),
    line('3', 'me', 5_000, 6_000, 'Good, thanks.'),
    line('4', 'me', 6_100, 7_000, ''),
    line('5', 'me', 7_200, 8_000, 'And you?'),
    line('6', 'them', 65_000, 66_000, 'Great.'),
  ]

  it('merges consecutive lines of the same speaker', () => {
    expect(TranscriptBuffer.format(lines)).toBe(
      ['Them: Hi there. How are you?', 'Me: Good, thanks. And you?', 'Them: Great.'].join('\n'),
    )
  })

  it('adds [mm:ss] timestamps from the first line of each turn', () => {
    expect(TranscriptBuffer.format(lines, { timestamps: true })).toBe(
      [
        '[00:01] Them: Hi there. How are you?',
        '[00:05] Me: Good, thanks. And you?',
        '[01:05] Them: Great.',
      ].join('\n'),
    )
  })

  it('switches to [h:mm:ss] past the first hour', () => {
    const late = [line('x', 'me', 3_723_000, 3_724_000, 'Wrapping up.')]
    expect(TranscriptBuffer.format(late, { timestamps: true })).toBe('[1:02:03] Me: Wrapping up.')
  })

  it('supports custom labels and empty input', () => {
    expect(TranscriptBuffer.format([], { timestamps: true })).toBe('')
    expect(
      TranscriptBuffer.format([line('a', 'me', 0, 1, 'hello')], { labels: { me: 'You' } }),
    ).toBe('You: hello')
  })

  it('formats timestamps defensively', () => {
    expect(formatTimestamp(0)).toBe('00:00')
    expect(formatTimestamp(59_999)).toBe('00:59')
    expect(formatTimestamp(83_000)).toBe('01:23')
    expect(formatTimestamp(-5)).toBe('00:00')
    expect(formatTimestamp(Number.NaN)).toBe('00:00')
    expect(formatTimestamp(36_000_000)).toBe('10:00:00')
  })
})
