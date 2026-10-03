import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { runMigrations } from '@main/db/migrations'
import {
  buildFtsQuery,
  buildSnippet,
  buildTrigramQuery,
  EXCERPT_MAX_CHARS,
  excerptAround,
  fuzzyMatch,
  looksLikeQuestion,
  SearchService,
  type SessionMatchLimits,
  tokenize,
  trigramsOf,
} from '@main/db/search'
import { SNIPPET_MARK_END, SNIPPET_MARK_START } from '@shared/constants'
import type { SearchResult } from '@shared/types'
import { DAY, line, makeRepos, seedSession, type Repos } from './fixtures'

const NOW = Date.UTC(2026, 5, 1)
const S = SNIPPET_MARK_START
const E = SNIPPET_MARK_END

function corpus(): Repos {
  const r = makeRepos()
  seedSession(r, {
    id: 'pricing',
    title: 'Quarterly pricing review',
    startedAt: NOW - 1 * DAY,
    lines: [
      ['them', 'What does the enterprise plan cost per seat?'],
      ['me', 'It starts at forty dollars per seat, billed annually.'],
      ['them', 'Do you offer discounts for nonprofits?'],
    ],
    notes: {
      title: 'Pricing',
      summary: 'Discussed enterprise pricing and nonprofit discounts.',
      keyPoints: [],
      decisions: [],
    },
    notesMarkdown: '## Summary\nDiscussed enterprise pricing and nonprofit discounts.',
    emailMarkdown: '**Subject:** Pricing follow-up\n\nThanks for your time today.',
    actionItems: [{ text: 'Send the enterprise pricing deck', owner: 'Me', due: 'Friday' }],
  })
  seedSession(r, {
    id: 'standup',
    title: 'Weekly standup',
    startedAt: NOW - 2 * DAY,
    lines: [
      ['them', 'The enterprise customer is blocked on SSO.'],
      ['me', 'I will look at the login flow today.'],
    ],
  })
  seedSession(r, {
    id: 'seats',
    title: 'Seat planning',
    startedAt: NOW - 3 * DAY,
    lines: [
      ['them', 'How many seats do we need?'],
      ['me', 'Ten seats for engineering.'],
      ['them', 'And five seats for sales.'],
      ['me', 'Two seats for support.'],
      ['them', 'One seat for the CEO.'],
    ],
  })
  seedSession(r, {
    id: 'bangla',
    title: 'বিক্রয় মিটিং',
    startedAt: NOW - 4 * DAY,
    lines: [
      ['them', 'আমরা কীভাবে দাম নির্ধারণ করব?'],
      ['me', 'প্রতি মাসে পাঁচশো টাকা।'],
    ],
  })
  return r
}

const sessionIds = (res: SearchResult) => res.groups.map((g) => g.session.id)

/**
 * In-memory database that records every statement it runs (with its bound values) and counts
 * the rows its statements hand back to JS.
 */
function tracedDb() {
  const statements: string[] = []
  const db = new Database(':memory:', { verbose: (sql) => statements.push(String(sql)) })
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  const read = { rows: 0 }
  const prepare = db.prepare.bind(db)
  db.prepare = ((source: string) => {
    const stmt = prepare(source)
    const all = stmt.all.bind(stmt) as (...params: unknown[]) => unknown[]
    const get = stmt.get.bind(stmt) as (...params: unknown[]) => unknown
    const iterate = stmt.iterate.bind(stmt) as (...params: unknown[]) => IterableIterator<unknown>
    return Object.assign(stmt, {
      all: (...params: unknown[]) => {
        const rows = all(...params)
        read.rows += rows.length
        return rows
      },
      get: (...params: unknown[]) => {
        const row = get(...params)
        if (row !== undefined) read.rows++
        return row
      },
      iterate: function* (...params: unknown[]) {
        for (const row of iterate(...params)) {
          read.rows++
          yield row
        }
      },
    })
  }) as typeof db.prepare
  return { db, statements, read }
}

/** Statements that searched the index (MATCH), from a tracedDb() log. */
const matchStatements = (statements: string[]) => statements.filter((sql) => /\bMATCH\b/.test(sql))

/**
 * 40 meetings of 200 lines (s39 is the most recent). Every line says exactly one of alpha,
 * bravo, charlie and — in even meetings — delta (echo in odd ones), so no line has two of
 * them; the first line of every meeting also says "zebra".
 */
function spreadCorpus(r: Repos): void {
  r.db.transaction(() => {
    for (let s = 0; s < 40; s++) {
      const id = `s${s}`
      r.sessions.create({ id, modeId: null, startedAt: NOW - (40 - s) * DAY })
      r.sessions.rename(id, `Meeting ${s}`)
      r.sessions.setStatus(id, 'done')
      const words = ['alpha', 'bravo', 'charlie', s % 2 === 0 ? 'delta' : 'echo']
      for (let i = 0; i < 200; i++) {
        const text = `${words[i % 4]}${i === 0 ? ' zebra' : ''} item ${i}`
        r.transcript.upsert(line(id, 'them', i * 1000, text))
      }
    }
  })()
}

/** The highlighted word of each hit's snippet. */
const markedWords = (hits: { snippet: string }[]) =>
  hits.map((h) => new RegExp(`${S}(\\w+)${E}`).exec(h.snippet)?.[1])

/** s38, s36, …, s0: the meetings of spreadCorpus() that say all of alpha … delta. */
const EVEN_MEETINGS = Array.from({ length: 20 }, (_, k) => `s${38 - 2 * k}`)

describe('tokenize / query builders', () => {
  it('extracts lower-case letter/digit runs (Bangla marks included), max 8, de-duplicated', () => {
    expect(tokenize('  Enterprise PLAN, q3-budget!! ')).toEqual([
      'enterprise',
      'plan',
      'q3',
      'budget',
    ])
    expect(tokenize('আমরা কীভাবে দাম')).toEqual(['আমরা', 'কীভাবে', 'দাম'])
    expect(tokenize('a b c d e f g h i j')).toHaveLength(8)
    expect(tokenize('plan Plan PLAN')).toEqual(['plan'])
    expect(tokenize('"*^:()-+')).toEqual([])
    expect(tokenize('\u0301')).toEqual([]) // a lone combining mark is not a token
  })

  it('drops possessives, contractions and one-letter pieces when a longer word exists', () => {
    expect(tokenize("acme's")).toEqual(['acme'])
    expect(tokenize('acme\u2019s plan')).toEqual(['acme', 'plan'])
    expect(tokenize("we'll don't they're I've I'd I'm")).toEqual(['we', 'don', 'they'])
    expect(tokenize('e-mail')).toEqual(['mail'])
    expect(tokenize('AT&T contract')).toEqual(['at', 'contract'])
    // Only one-letter tokens: kept (searched as one adjacent run).
    expect(tokenize('Q&A')).toEqual(['q', 'a'])
    expect(tokenize('s')).toEqual(['s'])
    // A quote that is not an apostrophe inside a word does not drop the letter.
    expect(tokenize("'s plan")).toEqual(['plan'])
  })

  it('builds quoted prefix queries and trigram OR queries', () => {
    expect(buildFtsQuery(['enter', 'plan'])).toBe('"enter"* AND "plan"*')
    expect(buildFtsQuery(['a', 'b'], 'OR')).toBe('"a"* OR "b"*')
    expect(buildFtsQuery(['say"hi'])).toBe('"say""hi"*')
    expect(trigramsOf('plans')).toEqual(['pla', 'lan', 'ans'])
    expect(trigramsOf('ab')).toEqual([])
    expect(buildTrigramQuery(['plan', 'lane'])).toBe('"pla" OR "lan" OR "ane"')
  })
})

describe('SearchService.query', () => {
  it('finds prefixes ("enter" → enterprise) with highlighted snippets across kinds', () => {
    const r = corpus()
    const res = r.search.query('enter')
    expect(res.fuzzy).toBe(false)
    expect(res.query).toBe('enter')
    expect(sessionIds(res)).toEqual(expect.arrayContaining(['pricing', 'standup']))
    const pricing = res.groups.find((g) => g.session.id === 'pricing')
    expect(pricing?.session.title).toBe('Quarterly pricing review')
    expect(pricing?.hits.length).toBeLessThanOrEqual(3)
    for (const g of res.groups) {
      for (const h of g.hits) {
        expect(h.snippet).toContain(`${S}`)
        expect(h.snippet).toContain(`${E}`)
        expect(h.snippet.toLowerCase()).toMatch(new RegExp(`${S}enterprise${E}`, 'i'))
        expect(h.sessionId).toBe(g.session.id)
        expect(h.score).toBeGreaterThan(0)
      }
    }
    const kinds = new Set(res.groups.flatMap((g) => g.hits.map((h) => h.kind)))
    expect(
      [...kinds].every((k) => ['title', 'transcript', 'notes', 'action_item', 'email'].includes(k)),
    ).toBe(true)
  })

  it('matches every kind: title, transcript, notes, action item and email', () => {
    const r = corpus()
    const kindsFor = (q: string) =>
      r.search
        .query(q)
        .groups.find((g) => g.session.id === 'pricing')
        ?.hits.map((h) => h.kind) ?? []
    expect(kindsFor('quarterly')).toEqual(['title'])
    expect(kindsFor('annually')).toEqual(['transcript'])
    expect(kindsFor('deck')).toEqual(['action_item'])
    expect(kindsFor('thanks')).toEqual(['email'])
    expect(kindsFor('nonprofit')).toEqual(expect.arrayContaining(['notes', 'transcript']))
    const deck = r.search.query('deck').groups[0]?.hits[0]
    expect(deck?.refId).toBe(r.actions.listBySession('pricing')[0]?.id)
  })

  it('ANDs multiple terms within one item', () => {
    const r = corpus()
    const res = r.search.query('enterprise seat')
    expect(sessionIds(res)).toEqual(['pricing'])
    expect(res.groups[0]?.hits.map((h) => h.kind)).toEqual(['transcript'])
    expect(sessionIds(r.search.query('enterprise nonexistentword'))).toEqual([])
  })

  it('finds meetings whose words are spread over several items (title, lines)', () => {
    const r = makeRepos()
    seedSession(r, {
      id: 'acme',
      title: 'Acme kickoff',
      startedAt: NOW - DAY,
      lines: [
        ['them', 'we discussed pricing in detail'],
        ['me', 'budget is tight'],
      ],
    })
    seedSession(r, {
      id: 'other',
      title: 'Pricing sync',
      startedAt: NOW - 2 * DAY,
      lines: [['them', 'nothing about money here']],
    })
    seedSession(r, {
      id: 'one-line',
      title: 'Budget call',
      startedAt: NOW - 3 * DAY,
      lines: [['them', 'the pricing budget is final']],
    })
    expect(sessionIds(r.search.query('acme'))).toEqual(['acme'])
    const acme = r.search.query('acme pricing')
    expect(sessionIds(acme)).toEqual(['acme'])
    expect(acme.fuzzy).toBe(false)
    expect(acme.groups[0]?.hits.map((h) => h.kind).sort()).toEqual(['title', 'transcript'])
    expect(acme.groups[0]?.hits.find((h) => h.kind === 'title')?.snippet).toBe(
      `${S}Acme${E} kickoff`,
    )
    // All words in one line ranks above words spread over the meeting.
    expect(sessionIds(r.search.query('pricing budget'))).toEqual(['one-line', 'acme'])
    expect(sessionIds(r.search.query('acme money'))).toEqual([])
  })

  it('keeps at most 3 hits per session', () => {
    const r = corpus()
    const res = r.search.query('seat')
    const seats = res.groups.find((g) => g.session.id === 'seats')
    expect(seats?.hits).toHaveLength(3)
    expect(seats?.hits[0]?.kind).toBe('title') // titles are boosted
  })

  it('orders sessions by best hit, then by recency', () => {
    const r = makeRepos()
    seedSession(r, {
      id: 'older',
      startedAt: NOW - 5 * DAY,
      lines: [['them', 'budget approval needed']],
    })
    seedSession(r, {
      id: 'newer',
      startedAt: NOW - 1 * DAY,
      lines: [['them', 'budget approval needed']],
    })
    seedSession(r, { id: 'title', title: 'Budget', startedAt: NOW - 9 * DAY })
    expect(sessionIds(r.search.query('budget'))).toEqual(['title', 'newer', 'older'])
    expect(sessionIds(r.search.query('budget', 2))).toEqual(['title', 'newer'])
  })

  it('tolerates typos with a trigram pass ("entreprise", "enterprse")', () => {
    const r = corpus()
    for (const typo of ['entreprise', 'enterprse', 'Enterprize']) {
      const res = r.search.query(typo)
      expect(res.fuzzy).toBe(true)
      expect(sessionIds(res)).toEqual(expect.arrayContaining(['pricing', 'standup']))
      const hit = res.groups[0]?.hits[0]
      expect(hit?.snippet.toLowerCase()).toContain(`${S}enterprise`)
    }
    const multi = r.search.query('entreprise sso')
    expect(multi.fuzzy).toBe(true)
    expect(sessionIds(multi)).toEqual(['standup'])
  })

  it('does not run the fuzzy pass when exact results suffice or tokens are short', () => {
    const r = corpus()
    seedSession(r, { id: 'x1', startedAt: NOW, lines: [['me', 'enterprise one']] })
    const res = r.search.query('enterprise')
    expect(res.groups.length).toBeGreaterThanOrEqual(3)
    expect(res.fuzzy).toBe(false)
    expect(r.search.query('xyz')).toMatchObject({ fuzzy: false, groups: [] })
    expect(r.search.query('zzzzzz')).toMatchObject({ fuzzy: false, groups: [] })
  })

  it('does not let scattered trigrams in long notes count as a fuzzy match', () => {
    const r = makeRepos()
    seedSession(r, {
      id: 'long',
      startedAt: NOW,
      notesMarkdown:
        'entry, interest, preparing, rise, wise, premise and tremendous representation',
    })
    expect(r.search.query('entreprise').groups).toEqual([])
  })

  it('matches Bangla text', () => {
    const r = corpus()
    expect(sessionIds(r.search.query('দাম'))).toEqual(['bangla'])
    expect(sessionIds(r.search.query('কীভাবে'))).toEqual(['bangla'])
    const title = r.search.query('বিক্রয়')
    expect(title.groups[0]?.hits[0]?.kind).toBe('title')
    expect(title.groups[0]?.hits[0]?.snippet).toContain(S)
    expect(sessionIds(r.search.query('পাঁচশো টাকা'))).toEqual(['bangla'])
  })

  it('never throws on FTS5 syntax or odd input', () => {
    const r = corpus()
    const inputs = [
      '"',
      '""',
      'AND',
      'OR',
      'NOT',
      'NEAR(',
      'NEAR(a b',
      '*',
      '-x',
      'col:val',
      'text:enterprise',
      '^',
      '^enter',
      '(',
      ')',
      '{a b}',
      "'",
      '\\',
      '%',
      'a OR',
      'enter*"',
      '😀',
      '\u0000',
      '\u0002\u0003',
      '\ud800',
      'x'.repeat(500),
      'a '.repeat(300),
    ]
    for (const q of inputs) {
      const res = r.search.query(q)
      expect(res.query).toBe(q)
      expect(Array.isArray(res.groups)).toBe(true)
    }
    // Column filters and operators are plain words: "text:enterprise" needs both words.
    expect(sessionIds(r.search.query('text:enterprise'))).toEqual([])
    expect(sessionIds(r.search.query('enterprise:plan'))).toEqual(['pricing'])
    expect(sessionIds(r.search.query('NEAR(enterprise plan'))).toEqual([])
    // "AND" is a plain word too: this meeting says "and" in its notes, "enterprise plan" in a line.
    expect(sessionIds(r.search.query('enterprise AND plan'))).toEqual(['pricing'])
    expect(sessionIds(r.search.query('enterprise NOT plan'))).toEqual([])
    expect(sessionIds(r.search.query('-annually'))).toEqual(['pricing'])
  })

  it("ignores possessives and one-letter pieces (\"acme's\", 'Q&A')", () => {
    const r = makeRepos()
    seedSession(r, {
      id: 'acme',
      title: 'Acme kickoff',
      startedAt: NOW - DAY,
      lines: [['them', 'Acme wants a discount']],
      notesMarkdown: 'Acme renewal planning',
    })
    seedSession(r, {
      id: 'qa',
      title: 'Q&A session',
      startedAt: NOW - 2 * DAY,
      lines: [['them', 'quick answer about apples']],
    })
    expect(sessionIds(r.search.query("acme's"))).toEqual(['acme'])
    expect(sessionIds(r.search.query('acme\u2019s'))).toEqual(['acme'])
    expect(sessionIds(r.search.query("Acme's renewal"))).toEqual(['acme'])
    // "Q&A" is the adjacent run q, a — not any q-word plus any a-word.
    const qa = r.search.query('Q&A')
    expect(sessionIds(qa)).toEqual(['qa'])
    expect(qa.groups[0]?.hits.map((h) => h.kind)).toEqual(['title'])
  })

  it('highlights only the adjacent run of a one-letter phrase ("Q&A"), not every q-/a-word', () => {
    const r = makeRepos()
    seedSession(r, {
      id: 'qa',
      title: 'Quick answers: Q&A about the API',
      startedAt: NOW - DAY,
      lines: [['them', 'quiet afternoon, nothing to ask']],
    })
    const qa = r.search.query('Q&A')
    expect(sessionIds(qa)).toEqual(['qa'])
    expect(qa.groups[0]?.hits.map((h) => h.snippet)).toEqual([
      `Quick answers: ${S}Q${E}&${S}A${E} about the API`,
    ])
  })

  it('runs one MATCH for a one-word query and never re-runs MATCH per hit', () => {
    // A one-letter prefix has no prefix index; re-running MATCH for every hit to build its
    // snippet (snippet() with rowid IN json_each(…)) froze the main process for seconds on a
    // large history. Snippets are built in JS from the stored text now.
    const { db, statements } = tracedDb()
    const r = makeRepos(db)
    const words = ['sales', 'sync', 'status', 'scope', 'seats', 'some', 'say', 'sure']
    db.transaction(() => {
      for (let s = 0; s < 30; s++) {
        r.sessions.create({ id: `m${s}`, modeId: null, startedAt: NOW - s * DAY })
        r.sessions.setStatus(`m${s}`, 'done')
        for (let i = 0; i < 20; i++) {
          r.transcript.upsert(
            line(`m${s}`, 'them', i * 1000, `${words[i % 8]} ${words[(i + s) % 8]} line ${i}`),
          )
        }
      }
    })()
    const perHitMatch = (sql: string) => /\bsnippet\s*\(|\bjson_each\b|\browid\s+IN\b/i.test(sql)
    for (const q of ['s', "sales's", 'say t', 'sales sync']) {
      statements.length = 0
      const res = r.search.query(q)
      expect(res.groups).toHaveLength(30)
      expect(res.groups.reduce((n, g) => n + g.hits.length, 0)).toBeGreaterThan(60)
      for (const g of res.groups) for (const h of g.hits) expect(h.snippet).toContain(S)
      const matches = matchStatements(statements)
      expect(matches.filter(perHitMatch)).toEqual([])
      // One word ("s", "sales's" → sales, "say t" → say): the candidate query and nothing else.
      if (tokenize(q).length === 1) expect(matches).toHaveLength(1)
    }
  })

  it('matches words spread over a meeting exactly while the work fits the limits', () => {
    const r = makeRepos()
    spreadCorpus(r)
    // No line has two of these words, so every match is at the meeting level.
    const all = r.search.query('alpha bravo charlie delta')
    expect(sessionIds(all)).toEqual(EVEN_MEETINGS)
    expect(all.fuzzy).toBe(false)
    for (const g of all.groups) {
      // One hit per word (≤ 3), each in a line of that meeting.
      expect(new Set(markedWords(g.hits)).size).toBe(3)
      expect(g.hits.every((h) => h.sessionId === g.session.id && h.kind === 'transcript')).toBe(
        true,
      )
    }
    const rare = r.search.query('zebra delta')
    expect(sessionIds(rare)).toEqual(EVEN_MEETINGS)
    for (const g of rare.groups) expect(markedWords(g.hits).sort()).toEqual(['delta', 'zebra'])
    expect(sessionIds(r.search.query('alpha echo', 5))).toEqual(['s39', 's37', 's35', 's33', 's31'])
  })

  it('caps the rows it reads to match words across a meeting, however common the words', () => {
    const { db, statements, read } = tracedDb()
    const r = makeRepos(db)
    spreadCorpus(r)
    const limits: SessionMatchLimits = { mapRows: 600, scanRows: 1000 }
    const search = new SearchService(db, undefined, limits)
    const run = (q: string) => {
      statements.length = 0
      read.rows = 0
      const res = search.query(q)
      // Nothing reads all rows of a word: every index search stops at a LIMIT, and none
      // aggregates a word's rows in SQL (GROUP BY reads every row of "the").
      for (const sql of matchStatements(statements)) {
        expect(sql).toMatch(/\bLIMIT\b/)
        expect(sql).not.toMatch(/\bGROUP BY\b/)
      }
      // Each of these words is in 1000–2000 lines; reading them all is 7000 rows.
      expect(read.rows).toBeLessThanOrEqual(limits.mapRows + limits.scanRows + 100)
      return res
    }

    // Every word is too common to map: the rarest (delta) proposes the meetings of its 600
    // newest lines, and the other words turn up within the first items of each of them.
    const common = run('alpha bravo charlie delta')
    expect(sessionIds(common)).toEqual(EVEN_MEETINGS.slice(0, 12))
    expect(common.fuzzy).toBe(false)
    for (const g of common.groups) expect(g.hits).toHaveLength(3)

    // "zebra" maps all 40 meetings; delta has to be looked for in each of them, and the odd
    // ones have to be read to the end to rule them out, until the scan budget runs out.
    const scanned = run('zebra delta')
    expect(sessionIds(scanned)).toEqual(EVEN_MEETINGS.slice(0, 4))
    for (const g of scanned.groups) {
      expect(g.hits.map((h) => h.snippet)).toEqual([
        `alpha ${S}zebra${E} item 0`,
        `${S}delta${E} item 3`,
      ])
    }
  })

  it('caps the rows read when a typo match leaves a common word to find in the meeting', () => {
    const { db, statements, read } = tracedDb()
    const r = makeRepos(db)
    db.transaction(() => {
      for (let s = 0; s < 10; s++) {
        const id = `t${s}`
        r.sessions.create({ id, modeId: null, startedAt: NOW - (10 - s) * DAY })
        r.sessions.setStatus(id, 'done')
        for (let i = 0; i < 100; i++) {
          r.transcript.upsert(line(id, 'them', i * 1000, `the plan for item ${i}`))
        }
        if (s >= 7) r.transcript.upsert(line(id, 'me', 200_000, 'zorblux report'))
      }
    })()
    const search = new SearchService(db, undefined, { mapRows: 50, scanRows: 100 })
    statements.length = 0
    read.rows = 0
    // "zorblax" is a typo of "zorblux" (one line); "th" is in every other line, never in that
    // one, so it is looked up elsewhere in each meeting: 1000 lines, read only up to the cap.
    const res = search.query('zorblax th')
    expect(res.fuzzy).toBe(true)
    expect(sessionIds(res)).toEqual(['t9', 't8', 't7'])
    for (const g of res.groups) {
      expect(g.hits.map((h) => h.snippet)).toEqual([
        `${S}zorblux${E} report`,
        `${S}the${E} plan for item 0`,
      ])
    }
    for (const sql of matchStatements(statements)) expect(sql).not.toMatch(/\bGROUP BY\b/)
    expect(read.rows).toBeLessThanOrEqual(50 + 100 + 30)
  })

  it('shows a hit for every word of a typo match spread over a meeting', () => {
    const r = makeRepos()
    seedSession(r, {
      id: 'zorb',
      startedAt: NOW - DAY,
      lines: [
        ['them', 'zorblux report one'],
        ['them', 'zorblux report two'],
        ['me', 'zorblux report five'],
        ['them', 'zorblux report four'],
        ['me', 'the plan is ready'],
      ],
    })
    // "zorblax" is a typo of zorblux (four lines); "th" only in another line. At most 3 hits
    // are shown: the best typo line, then the line that has the other word, then more typos.
    const res = r.search.query('zorblax th')
    expect(res.fuzzy).toBe(true)
    expect(sessionIds(res)).toEqual(['zorb'])
    const hits = res.groups[0]?.hits ?? []
    expect(hits).toHaveLength(3)
    expect(markedWords(hits)).toEqual(['zorblux', 'the', 'zorblux'])
  })

  it('finds Bangla text whose stored form was not NFC (precomposed য়)', () => {
    const r = makeRepos()
    const precomposed = '\u09b8\u09ae\u09df' // সময় with U+09DF
    expect(precomposed.normalize('NFC')).not.toBe(precomposed)
    seedSession(r, {
      id: 'bn',
      title: `${precomposed} নিয়ে কথা`,
      startedAt: NOW - DAY,
      lines: [['them', `আমাদের ${precomposed} কম আছে`]],
      notesMarkdown: `${precomposed} কম`,
      actionItems: [{ text: `${precomposed} ঠিক করা` }],
    })
    for (const q of [precomposed, precomposed.normalize('NFC')]) {
      const res = r.search.query(q)
      expect(sessionIds(res)).toEqual(['bn'])
      expect(res.fuzzy).toBe(false)
    }
    expect(r.search.retrieveForQuestion(`${precomposed} কত?`).length).toBeGreaterThan(0)
    // Stored in NFC, so the stored text equals what queries are normalized to.
    expect(r.transcript.listBySession('bn')[0]?.text).toBe(
      `আমাদের ${precomposed} কম আছে`.normalize('NFC'),
    )
  })

  it('returns an empty result for empty or whitespace queries', () => {
    const r = corpus()
    for (const q of ['', '   ', '\n\t']) {
      expect(r.search.query(q)).toEqual({
        query: q,
        looksLikeQuestion: false,
        fuzzy: false,
        groups: [],
      })
    }
  })

  it('flags question-like queries', () => {
    const r = corpus()
    expect(r.search.query('what does enterprise cost?').looksLikeQuestion).toBe(true)
    expect(r.search.query('enterprise').looksLikeQuestion).toBe(false)
    expect(r.search.looksLikeQuestion('how much')).toBe(true)
  })

  it('reflects deletes and renames immediately', () => {
    const r = corpus()
    r.sessions.delete('standup')
    expect(sessionIds(r.search.query('enterprise'))).toEqual(['pricing'])
    r.sessions.rename('seats', 'Headcount')
    expect(r.search.query('headcount').groups[0]?.session.title).toBe('Headcount')
  })
})

describe('looksLikeQuestion', () => {
  const positives = [
    'What did we decide about pricing',
    'what did we decide?',
    'Why was the launch moved',
    'How much does it cost',
    'when is the next call',
    'Where are the slides',
    'Who owns onboarding',
    'Which plan did they pick',
    'Can we ship Friday',
    'Could you resend it',
    'Would they accept',
    'Should I follow up',
    'Do they need SSO',
    'Does Acme use Slack',
    'Did Sarah send the deck',
    'Is the demo ready',
    'Are we on track',
    'Will it scale',
    'Have we priced it',
    'Has legal approved',
    'pricing for acme?',
    'pricing for acme ?  ',
    'budget？',
    'الميزانية؟',
    '"is this a question?"',
    // Bangla
    'কি হয়েছে',
    'কী সিদ্ধান্ত হলো',
    'কেন দেরি হলো',
    'কিভাবে দাম ঠিক হবে',
    'কীভাবে দাম ঠিক হবে',
    'কখন মিটিং',
    'কোথায় দেখা হবে',
    'কে দায়িত্বে',
    'কোনটা ভালো',
    'কোন প্ল্যান',
    'কত টাকা',
    'দাম কত?',
  ]
  const negatives = [
    '',
    '   ',
    'pricing',
    'enterprise plan',
    'Howard notes',
    'whatever happened',
    'the what',
    'Isabel follow-up',
    'Doing great',
    'দাম নির্ধারণ',
    'মিটিং নোট',
    'কলকাতা অফিস',
  ]
  it.each(positives)('question: %s', (q) => expect(looksLikeQuestion(q)).toBe(true))
  it.each(negatives)('not a question: %s', (q) => expect(looksLikeQuestion(q)).toBe(false))
})

describe('fuzzy helpers', () => {
  it('matches per word with ≥ 40 % of trigrams and requires short tokens as prefixes', () => {
    expect(fuzzyMatch('The enterprise plan', ['entreprise'])?.share).toBeCloseTo(0.5)
    expect(fuzzyMatch('The enterprise plan', ['entreprise', 'pl'])).not.toBeNull()
    expect(fuzzyMatch('The enterprise plan', ['entreprise', 'zz'])).toBeNull()
    expect(fuzzyMatch('nothing relevant', ['entreprise'])).toBeNull()
    expect(fuzzyMatch('', ['abc'])).toBeNull()
  })

  it('builds a marked snippet of about 12 words around the first match', () => {
    const text = Array.from({ length: 40 }, (_, i) => `w${i}`).join(' ')
    const m = fuzzyMatch(text, ['w20'])
    if (!m) throw new Error('expected a match')
    const snip = buildSnippet(text, m.words, m.marked)
    expect(snip.startsWith('…')).toBe(true)
    expect(snip.endsWith('…')).toBe(true)
    expect(snip).toContain(`${S}w20${E}`)
    expect(snip.replace(/…/g, '').trim().split(/\s+/)).toHaveLength(12)
    const short = fuzzyMatch('Hi there enterprise!', ['enterprse'])
    if (!short) throw new Error('expected a match')
    expect(buildSnippet('Hi there enterprise!', short.words, short.marked)).toBe(
      `Hi there ${S}enterprise${E}!`,
    )
  })
})

describe('retrieveForQuestion', () => {
  function meeting(r: Repos, id: string, startedAt: number, texts: string[]) {
    seedSession(r, {
      id,
      title: id === 'untitled' ? undefined : `Meeting ${id}`,
      startedAt,
      lines: texts.map((t, i): ['me' | 'them', string] => [i % 2 ? 'me' : 'them', t]),
    })
  }

  it('expands transcript hits with ±2 labelled neighbour lines', () => {
    const r = makeRepos()
    meeting(
      r,
      'a',
      NOW,
      Array.from({ length: 10 }, (_, i) => (i === 5 ? 'The zebra budget is fixed' : `line ${i}`)),
    )
    const [ex, ...rest] = r.search.retrieveForQuestion('What about the zebra budget?')
    expect(rest).toEqual([])
    expect(ex).toMatchObject({
      sessionId: 'a',
      title: 'Meeting a',
      startedAt: NOW,
      kind: 'transcript',
    })
    expect(ex?.text.split('\n')).toEqual([
      'Me: line 3',
      'Them: line 4',
      'Me: The zebra budget is fixed',
      'Them: line 6',
      'Me: line 7',
    ])
  })

  it('merges overlapping windows of the same session', () => {
    const r = makeRepos()
    const texts = Array.from({ length: 20 }, (_, i) => `line ${i}`)
    texts[4] = 'zebra one'
    texts[7] = 'zebra two'
    texts[16] = 'zebra three'
    meeting(r, 'a', NOW, texts)
    const out = r.search.retrieveForQuestion('zebra')
    expect(out).toHaveLength(2)
    const merged = out.find((x) => x.text.includes('zebra one'))
    expect(merged?.text).toContain('zebra two')
    expect(merged?.text.split('\n')).toHaveLength(8) // lines 2..9
    expect(out.find((x) => x.text.includes('zebra three'))?.text.split('\n')).toHaveLength(5)
  })

  it('merges a window that bridges two earlier ones', () => {
    const r = makeRepos()
    const texts = Array.from({ length: 20 }, (_, i) => `line ${i}`)
    texts[3] = 'zebra alpha zebra zebra' // ranks first
    texts[11] = 'zebra beta zebra zebra' // ranks second
    texts[7] = 'zebra gamma' // ranks last, overlaps both windows
    meeting(r, 'a', NOW, texts)
    const out = r.search.retrieveForQuestion('zebra')
    expect(out).toHaveLength(1)
    expect(out[0]?.text).toContain('alpha')
    expect(out[0]?.text).toContain('beta')
    expect(out[0]?.text).toContain('gamma')
  })

  it('caps excerpts at ~800 chars, keeping the hit line', () => {
    const r = makeRepos()
    const long = (n: number) => `${'context '.repeat(50)}${n}`
    meeting(r, 'a', NOW, [long(0), long(1), 'the zebra decision', long(3), long(4)])
    const [ex] = r.search.retrieveForQuestion('zebra')
    expect(ex?.text.length).toBeLessThanOrEqual(EXCERPT_MAX_CHARS)
    expect(ex?.text).toContain('Them: the zebra decision')
  })

  it('returns at most k excerpts, best first, across sessions and kinds', () => {
    const r = makeRepos()
    for (let s = 0; s < 6; s++) {
      meeting(
        r,
        `m${s}`,
        NOW - s * DAY,
        Array.from({ length: 30 }, (_, i) => (i % 6 === 0 ? `zebra ${i}` : `x ${i}`)),
      )
    }
    expect(r.search.retrieveForQuestion('zebra', 4)).toHaveLength(4)
    expect(r.search.retrieveForQuestion('zebra', 12)).toHaveLength(12)
    expect(r.search.retrieveForQuestion('zebra', 0)).toEqual([])
  })

  it('uses stored notes markdown, action items and titles, ignoring stopwords', () => {
    const r = corpus()
    const out = r.search.retrieveForQuestion('What did we decide about the nonprofit discounts?')
    const notes = out.find((x) => x.kind === 'notes')
    expect(notes?.text).toBe('## Summary\nDiscussed enterprise pricing and nonprofit discounts.')
    expect(notes?.title).toBe('Quarterly pricing review')
    const deck = r.search.retrieveForQuestion('Who sends the pricing deck?')
    expect(deck.find((x) => x.kind === 'action_item')?.text).toBe(
      '[ ] Send the enterprise pricing deck (Me, Friday)',
    )
    const title = r.search.retrieveForQuestion('quarterly?')
    expect(title[0]).toMatchObject({ kind: 'title', sessionId: 'pricing' })
    expect(title[0]?.text).toContain('Discussed enterprise pricing')
  })

  it('falls back to OR and to fuzzy matching, and names untitled sessions', () => {
    const r = corpus()
    meeting(r, 'untitled', NOW, ['kangaroo logistics'])
    const or = r.search.retrieveForQuestion('enterprise kangaroo')
    expect(new Set(or.map((x) => x.sessionId))).toEqual(new Set(['pricing', 'standup', 'untitled']))
    expect(or.find((x) => x.sessionId === 'untitled')?.title).toBe('Untitled meeting')
    expect(r.search.retrieveForQuestion('entreprise?').length).toBeGreaterThan(0)
    expect(r.search.retrieveForQuestion('')).toEqual([])
    expect(r.search.retrieveForQuestion('"*^')).toEqual([])
  })

  it('cuts long notes around the match', () => {
    const r = makeRepos()
    const md = `${'Intro paragraph words. '.repeat(60)}\n- The zebra decision was final.\n${'Outro words here. '.repeat(60)}`
    seedSession(r, { id: 'n', title: 'Notes', startedAt: NOW, notesMarkdown: md })
    const [ex] = r.search.retrieveForQuestion('zebra')
    expect(ex?.kind).toBe('notes')
    expect(ex?.text.length).toBeLessThanOrEqual(EXCERPT_MAX_CHARS)
    expect(ex?.text).toContain('The zebra decision was final.')
    expect(excerptAround('short', ['x'])).toBe('short')
    const cut = excerptAround('a '.repeat(1000) + 'needle ' + 'b '.repeat(1000), ['needle'], 100)
    expect(cut.length).toBeLessThanOrEqual(100)
    expect(cut).toContain('needle')
    expect(cut.startsWith('…') && cut.endsWith('…')).toBe(true)
  })
})
