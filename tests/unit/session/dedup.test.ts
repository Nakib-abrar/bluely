import { describe, expect, it } from 'vitest'
import { EchoDeduper, containment, normalizeForComparison, similarity } from '@main/session/dedup'
import type { Channel, TranscriptLine } from '@shared/types'

let seq = 0
function line(channel: Channel, startMs: number, endMs: number, text: string, id?: string) {
  return {
    id: id ?? `${channel}-${++seq}`,
    sessionId: 's1',
    channel,
    startMs,
    endMs,
    text,
    isFinal: true,
  } satisfies TranscriptLine
}

describe('similarity', () => {
  it('normalizes case, punctuation and whitespace (Unicode-aware)', () => {
    expect(normalizeForComparison('  Hello,   WORLD!! ')).toBe('hello world')
    expect(normalizeForComparison('Don’t stop — ever.')).toBe('dont stop ever')
    expect(normalizeForComparison('আমরা কাল মিটিং করব।')).toBe('আমরা কাল মিটিং করব')
    expect(similarity('Hello, world!', 'hello world')).toBe(1)
    expect(similarity('আমরা কাল মিটিং করব।', 'আমরা কাল মিটিং করব')).toBe(1)
  })

  it('returns 1 for identical text and 0 for unrelated or empty text', () => {
    expect(similarity('We should ship on Friday', 'We should ship on Friday')).toBe(1)
    expect(similarity('', '')).toBe(1)
    expect(similarity('something', '')).toBe(0)
    expect(similarity('the cat sat on the mat', 'quarterly revenue grew twelve percent')).toBe(0)
  })

  it('uses Dice on word bigrams for longer strings', () => {
    // 3 of 4 bigrams shared each way: 2·3 / (4 + 4)
    expect(similarity('the quick brown fox jumps', 'the quick brown fox leaps')).toBeCloseTo(
      0.75,
      5,
    )
    // Repeated bigrams count as a multiset.
    expect(similarity('go go go go', 'go go go go go go')).toBeCloseTo((2 * 3) / (3 + 5), 5)
  })

  it('falls back to character trigrams for short strings', () => {
    // " night " vs " nacht ": 5 trigrams each, only "ht " shared → 2·1 / 10
    expect(similarity('night', 'nacht')).toBeCloseTo(0.2, 5)
    expect(similarity('sounds good', 'sound good')).toBeGreaterThan(0.75)
    expect(similarity('yes', 'no')).toBe(0)
  })

  it('is symmetric and bounded', () => {
    const pairs: [string, string][] = [
      ['we need to finish the migration this week', 'we need to finish migration this week'],
      ['hi', 'hello there friend'],
      ['ok', 'okay'],
    ]
    for (const [a, b] of pairs) {
      const s = similarity(a, b)
      expect(s).toBe(similarity(b, a))
      expect(s).toBeGreaterThanOrEqual(0)
      expect(s).toBeLessThanOrEqual(1)
    }
  })

  it('tolerates a one-word STT difference in a long line', () => {
    const them = 'so the plan is to migrate the billing service to the new cluster next week'
    const me = 'so the plan is to migrate the billing service to a new cluster next week'
    expect(similarity(them, me)).toBeGreaterThanOrEqual(0.8)
  })

  it('measures containment of a fragment', () => {
    expect(
      containment(
        'migrate the billing service',
        'so the plan is to migrate the billing service next week',
      ),
    ).toBe(1)
    expect(containment('totally different words here', 'so the plan is to migrate')).toBe(0)
  })
})

describe('EchoDeduper', () => {
  const them = 'Can you walk me through how the onboarding flow works today'

  it('drops a Me line that echoes an earlier Them line', () => {
    const d = new EchoDeduper()
    const t = line('them', 10_000, 13_000, them)
    expect(d.checkThem(t)).toEqual([])
    const r = d.checkMe(
      line('me', 10_200, 13_300, 'can you walk me through how the onboarding flow works today'),
    )
    expect(r).toEqual({ drop: true, matchedId: t.id })
    expect(d.echoCount).toBe(1)
  })

  it('retracts an earlier Me line when the Them line arrives later', () => {
    const d = new EchoDeduper()
    const me = line(
      'me',
      10_100,
      13_100,
      'Can you walk me through how the onboarding flow works today?',
    )
    expect(d.checkMe(me)).toEqual({ drop: false, matchedId: null })
    expect(d.echoCount).toBe(0)
    expect(d.checkThem(line('them', 10_000, 13_000, them))).toEqual([me.id])
    expect(d.echoCount).toBe(1)
    // Already retracted: a second Them copy doesn't retract or count it again.
    expect(d.checkThem(line('them', 10_000, 13_000, them))).toEqual([])
    expect(d.echoCount).toBe(1)
  })

  it('keeps lines outside the ±window', () => {
    const d = new EchoDeduper({ windowMs: 3000 })
    d.checkThem(line('them', 10_000, 13_000, them))
    // Starts 3.5 s after the Them line ended.
    expect(d.checkMe(line('me', 16_500, 19_000, them)).drop).toBe(false)
    // Ends 3.2 s before the Them line started.
    expect(d.checkMe(line('me', 4_000, 6_800, them)).drop).toBe(false)
    // Just inside the window.
    expect(d.checkMe(line('me', 15_900, 18_000, them)).drop).toBe(true)
    expect(d.echoCount).toBe(1)
  })

  it('does not retract Me lines outside the window when Them arrives later', () => {
    const d = new EchoDeduper()
    const early = line('me', 1_000, 3_000, them)
    d.checkMe(early)
    expect(d.checkThem(line('them', 10_000, 13_000, them))).toEqual([])
  })

  it('keeps genuine replies that are not similar', () => {
    const d = new EchoDeduper()
    d.checkThem(line('them', 10_000, 13_000, them))
    expect(
      d.checkMe(line('me', 13_500, 16_000, 'Sure, it starts with a signup form and an email check'))
        .drop,
    ).toBe(false)
    expect(d.checkMe(line('me', 13_500, 14_000, 'Yes.')).drop).toBe(false)
    expect(d.echoCount).toBe(0)
  })

  it('drops an echo fragment that overlaps a longer Them line in time', () => {
    const d = new EchoDeduper()
    const t = line(
      'them',
      20_000,
      28_000,
      'We migrated the billing service last quarter and the latency dropped by half, which was great',
    )
    d.checkThem(t)
    const r = d.checkMe(
      line('me', 22_000, 25_000, 'the billing service last quarter and the latency dropped'),
    )
    expect(r).toEqual({ drop: true, matchedId: t.id })
  })

  it('keeps a quoted fragment that comes after the Them line (not simultaneous)', () => {
    const d = new EchoDeduper()
    d.checkThem(
      line(
        'them',
        20_000,
        28_000,
        'We migrated the billing service last quarter and the latency dropped by half, which was great',
      ),
    )
    // Within ±3 s but after the Them line ended: the user is repeating it back, not an echo.
    expect(d.checkMe(line('me', 29_000, 31_000, 'so the latency dropped by half')).drop).toBe(false)
  })

  it('matches an echo that spans two Them lines split at a pause', () => {
    const d = new EchoDeduper()
    const a = line('them', 5_000, 7_000, 'We looked at three vendors last month')
    const b = line('them', 7_600, 9_500, 'and the cheapest one had the worst support')
    d.checkThem(a)
    d.checkThem(b)
    const r = d.checkMe(
      line(
        'me',
        5_100,
        9_600,
        'we looked at three vendors last month and the cheapest one had the worst support',
      ),
    )
    expect(r.drop).toBe(true)
    expect([a.id, b.id]).toContain(r.matchedId)
  })

  it('works for Bangla text', () => {
    const d = new EchoDeduper()
    const t = line('them', 1_000, 4_000, 'আমরা আগামী সপ্তাহে নতুন সংস্করণ প্রকাশ করব।')
    d.checkThem(t)
    expect(
      d.checkMe(line('me', 1_100, 4_100, 'আমরা আগামী সপ্তাহে নতুন সংস্করণ প্রকাশ করব')).drop,
    ).toBe(true)
  })

  it('does not count the same Me line twice and ignores empty lines', () => {
    const d = new EchoDeduper()
    d.checkThem(line('them', 10_000, 13_000, them))
    const me = line('me', 10_100, 13_100, them, 'me-fixed')
    expect(d.checkMe(me).drop).toBe(true)
    expect(d.checkMe(me).drop).toBe(true)
    expect(d.echoCount).toBe(1)
    expect(d.checkMe(line('me', 10_100, 13_100, '  ...  ')).drop).toBe(false)
    expect(d.checkThem(line('them', 10_100, 13_100, ''))).toEqual([])
  })

  it('bounds history by time and by count', () => {
    const d = new EchoDeduper({ historyMs: 10_000, maxLines: 50 })
    for (let i = 0; i < 300; i++) {
      d.checkThem(line('them', i * 100, i * 100 + 80, `them line number ${i} with some words`))
      d.checkMe(line('me', i * 100, i * 100 + 80, `my own unrelated reply ${i} about pricing`))
    }
    const size = d.historySize
    expect(size.them).toBeLessThanOrEqual(50)
    expect(size.me).toBeLessThanOrEqual(50)

    const t = new EchoDeduper({ historyMs: 10_000 })
    t.checkThem(line('them', 0, 2_000, them))
    // A much later line advances the clock past historyMs; the old line is forgotten.
    t.checkThem(line('them', 30_000, 31_000, 'a later unrelated sentence from them'))
    expect(t.historySize.them).toBe(1)
  })

  it('reset() clears history and the echo count', () => {
    const d = new EchoDeduper()
    d.checkThem(line('them', 10_000, 13_000, them))
    d.checkMe(line('me', 10_100, 13_100, them))
    expect(d.echoCount).toBe(1)
    d.reset()
    expect(d.echoCount).toBe(0)
    expect(d.historySize).toEqual({ me: 0, them: 0 })
    expect(d.checkMe(line('me', 10_100, 13_100, them)).drop).toBe(false)
  })

  it('updates a line re-sent with the same id instead of duplicating it', () => {
    const d = new EchoDeduper()
    d.checkThem(line('them', 10_000, 11_000, 'partial words', 'them-1'))
    d.checkThem(line('them', 10_000, 13_000, them, 'them-1'))
    expect(d.historySize.them).toBe(1)
    expect(d.checkMe(line('me', 10_100, 13_100, them)).matchedId).toBe('them-1')
  })
})
