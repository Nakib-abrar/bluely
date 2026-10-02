import type { Statement } from 'better-sqlite3'
import { SNIPPET_MARK_END, SNIPPET_MARK_START } from '@shared/constants'
import type {
  Channel,
  SearchGroup,
  SearchHit,
  SearchHitKind,
  SearchResult,
  SessionStatus,
  SessionSummary,
} from '@shared/types'
import { ht } from '../data/messages'
import type { Logger } from '../log'
import type { Db } from './database'
import { mapSessionRow, parseSummaryJson, SESSION_SUMMARY_COLUMNS } from './repos/sessionsRepo'
import { TRANSCRIPT_COLUMNS, TRANSCRIPT_ORDER, type TranscriptRow } from './repos/transcriptRepo'

// ───────────────────────────── tokens & query building ─────────────────────────────

const MAX_TOKENS = 8
/** Letters, digits and combining marks (Bangla vowel signs, virama), plus ZWNJ/ZWJ inside words. */
const TOKEN_RE = /[\p{L}\p{N}\p{M}\u200c\u200d]+/gu
const HAS_BASE_CHAR_RE = /[\p{L}\p{N}]/u
const EDGE_JOINERS_RE = /^[\u200c\u200d]+|[\u200c\u200d]+$/g

/**
 * Splits user input into lower-case search tokens (max 8, de-duplicated). Everything that is
 * not a letter, digit or mark is a separator, which is what makes FTS5 syntax inert:
 * quotes, operators, `*`, `^`, `col:` and parentheses never reach the MATCH expression.
 */
export function tokenize(input: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const m of input.normalize('NFC').toLowerCase().matchAll(TOKEN_RE)) {
    const tok = m[0].replace(EDGE_JOINERS_RE, '')
    if (!tok || !HAS_BASE_CHAR_RE.test(tok) || seen.has(tok)) continue
    seen.add(tok)
    out.push(tok)
    if (out.length >= MAX_TOKENS) break
  }
  return out
}

function quote(token: string): string {
  return `"${token.replace(/"/g, '""')}"`
}

/** Prefix match for every token: `"tok1"* AND "tok2"*` (or OR-joined). */
export function buildFtsQuery(tokens: string[], op: 'AND' | 'OR' = 'AND'): string {
  return tokens.map((t) => `${quote(t)}*`).join(` ${op} `)
}

function codePoints(s: string): string[] {
  return Array.from(s)
}

/** All 3-code-point substrings of a token (the unit the trigram tokenizer indexes). */
export function trigramsOf(token: string): string[] {
  const cps = codePoints(token)
  const out = new Set<string>()
  for (let i = 0; i + 3 <= cps.length; i++) out.add(cps.slice(i, i + 3).join(''))
  return [...out]
}

/** `"ent" OR "ntr" OR …` over the trigrams of every token with ≥ 3 characters. */
export function buildTrigramQuery(tokens: string[]): string {
  const all = new Set<string>()
  for (const t of tokens) for (const tri of trigramsOf(t)) all.add(tri)
  return [...all].map(quote).join(' OR ')
}

// ───────────────────────────── question detection ─────────────────────────────

const EN_INTERROGATIVES = [
  'what',
  'why',
  'how',
  'when',
  'where',
  'who',
  'which',
  'can',
  'could',
  'would',
  'should',
  'do',
  'does',
  'did',
  'is',
  'are',
  'will',
  'have',
  'has',
]
const BN_INTERROGATIVES = [
  'কি',
  'কী',
  'কেন',
  'কিভাবে',
  'কীভাবে',
  'কখন',
  'কোথায়',
  'কে',
  'কোনটা',
  'কোন',
  'কত',
]
const INTERROGATIVES = new Set(
  [...EN_INTERROGATIVES, ...BN_INTERROGATIVES].map((w) => w.normalize('NFC')),
)
const QUESTION_END_RE = /[?？؟][\s"'”’»)\]]*$/u

/**
 * True when the search box text reads like a question for "Ask Bluely across your meetings":
 * it ends with ?, ؟ or ？, or starts with an English or Bangla interrogative.
 */
export function looksLikeQuestion(q: string): boolean {
  const s = q.normalize('NFC').trim()
  if (!s) return false
  if (QUESTION_END_RE.test(s)) return true
  const first = s.toLowerCase().match(TOKEN_RE)?.[0]?.replace(EDGE_JOINERS_RE, '')
  return !!first && INTERROGATIVES.has(first)
}

// Words that carry no topic in "ask across meetings" questions.
const STOPWORDS = new Set(
  [
    ...EN_INTERROGATIVES,
    ...BN_INTERROGATIVES,
    'a',
    'an',
    'the',
    'and',
    'or',
    'but',
    'if',
    'then',
    'of',
    'to',
    'in',
    'on',
    'at',
    'for',
    'with',
    'about',
    'from',
    'by',
    'as',
    'into',
    'was',
    'were',
    'be',
    'been',
    'am',
    'had',
    'may',
    'might',
    'must',
    'shall',
    'i',
    'we',
    'you',
    'they',
    'he',
    'she',
    'it',
    'me',
    'us',
    'him',
    'her',
    'them',
    'my',
    'our',
    'your',
    'their',
    'its',
    'this',
    'that',
    'these',
    'those',
    'there',
    'any',
    'some',
    'all',
    'not',
    'so',
    'just',
    'also',
    'tell',
    'say',
    'said',
    'ask',
    'asked',
    'please',
    'meeting',
    'meetings',
    'discuss',
    'discussed',
    'mention',
    'mentioned',
    'talk',
    'talked',
    'know',
    'get',
    'got',
    'আমি',
    'আমরা',
    'আমার',
    'আমাদের',
    'তুমি',
    'তোমার',
    'আপনি',
    'আপনার',
    'সে',
    'তারা',
    'তাদের',
    'এই',
    'ওই',
    'সেই',
    'যে',
    'এবং',
    'ও',
    'আর',
    'না',
    'হয়',
    'হয়েছে',
    'ছিল',
    'আছে',
    'করে',
    'করা',
    'নিয়ে',
    'সম্পর্কে',
    'বলেছিল',
    'বলেছে',
    'মিটিং',
    'মিটিংয়ে',
  ].map((w) => w.normalize('NFC')),
)

// ───────────────────────────── fuzzy matching ─────────────────────────────

/** Share of a token's trigrams that must occur in one word of the hit for a fuzzy match. */
export const FUZZY_MIN_TRIGRAM_SHARE = 0.4

interface Word {
  start: number
  end: number
  lower: string
}

function wordsOf(text: string): Word[] {
  const out: Word[] = []
  for (const m of text.matchAll(TOKEN_RE)) {
    out.push({ start: m.index, end: m.index + m[0].length, lower: m[0].toLowerCase() })
  }
  return out
}

interface FuzzyMatch {
  /** Mean best trigram share over the fuzzy tokens (0..1). */
  share: number
  /** Indexes into `words` to highlight. */
  marked: Set<number>
  words: Word[]
}

/**
 * Typo-tolerant check done in JS on the hit text: every token with ≥ 3 characters must share
 * ≥ 40 % of its trigrams with a single word of the text (comparing per word keeps long notes
 * from matching on scattered trigrams), and shorter tokens must prefix some word.
 */
export function fuzzyMatch(text: string, tokens: string[]): FuzzyMatch | null {
  const words = wordsOf(text)
  if (!words.length) return null
  const marked = new Set<number>()
  let shareSum = 0
  let fuzzyCount = 0
  for (const token of tokens) {
    const tris = trigramsOf(token)
    if (!tris.length) {
      const idx = words.findIndex((w) => w.lower.startsWith(token))
      if (idx < 0) return null
      marked.add(idx)
      continue
    }
    let best = 0
    let bestIdx = -1
    words.forEach((w, i) => {
      if (w.lower.length < 3) return
      let hit = 0
      for (const tri of tris) if (w.lower.includes(tri)) hit++
      const share = hit / tris.length
      if (share > best) {
        best = share
        bestIdx = i
      }
    })
    if (best < FUZZY_MIN_TRIGRAM_SHARE) return null
    marked.add(bestIdx)
    shareSum += best
    fuzzyCount++
  }
  return { share: fuzzyCount ? shareSum / fuzzyCount : 1, marked, words }
}

const SNIPPET_WORDS = 12

/** Builds a highlighted snippet like FTS5 snippet(): ~12 words around the first match. */
export function buildSnippet(text: string, words: Word[], marked: Set<number>): string {
  if (!words.length) return text.slice(0, 200)
  const first = Math.min(...marked)
  const start = Math.max(0, Math.min(first - 2, words.length - SNIPPET_WORDS))
  const end = Math.min(words.length, start + SNIPPET_WORDS)
  let out = start > 0 ? '…' : ''
  let cursor = words[start]?.start ?? 0
  for (let i = start; i < end; i++) {
    const w = words[i]
    if (!w) continue
    out += text.slice(cursor, w.start)
    const raw = text.slice(w.start, w.end)
    out += marked.has(i) ? `${SNIPPET_MARK_START}${raw}${SNIPPET_MARK_END}` : raw
    cursor = w.end
  }
  if (end < words.length) out += '…'
  else out += text.slice(cursor)
  return out
}

// ───────────────────────────── retrieval helpers ─────────────────────────────

/** Upper bound for each excerpt handed to the "ask across meetings" prompt. */
export const EXCERPT_MAX_CHARS = 800
const NEIGHBOUR_LINES = 2
const SPEAKER: Record<Channel, string> = { me: 'Me', them: 'Them' }

/** Cuts `text` to ≤ max chars around the first occurrence of any token, on word boundaries. */
export function excerptAround(text: string, tokens: string[], max = EXCERPT_MAX_CHARS): string {
  const clean = text.trim()
  if (clean.length <= max) return clean
  const lower = clean.toLowerCase()
  let idx = -1
  for (const t of tokens) {
    const i = lower.indexOf(t)
    if (i >= 0 && (idx < 0 || i < idx)) idx = i
  }
  if (idx < 0 || idx >= clean.length) idx = 0
  let start = Math.max(0, idx - Math.floor(max / 3))
  if (start > 0) {
    // Prefer starting at a line (markdown bullet) or at least a word boundary.
    const nl = clean.lastIndexOf('\n', idx)
    if (nl >= start) start = nl + 1
    else {
      const sp = clean.indexOf(' ', start)
      if (sp >= 0 && sp < idx) start = sp + 1
    }
  }
  const budget = max - (start > 0 ? 1 : 0) - 1
  let end = Math.min(clean.length, start + budget)
  if (end < clean.length) {
    const sp = clean.lastIndexOf(' ', end)
    if (sp > idx && sp > start) end = sp
  }
  const body = clean.slice(start, end).trim()
  return `${start > 0 ? '…' : ''}${body}${end < clean.length ? '…' : ''}`
}

function hardCap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/** One excerpt for the "Ask Bluely across your meetings" prompt. */
export interface RetrievedExcerpt {
  sessionId: string
  /** Session title (falls back to "Untitled meeting" so citations always have a name). */
  title: string
  startedAt: number
  kind: SearchHitKind
  text: string
}

// ───────────────────────────── service ─────────────────────────────

interface FtsRow {
  rid: number
  session_id: string
  kind: SearchHitKind
  ref_id: string | null
  score: number
}

interface TrigramRow extends FtsRow {
  text: string
}

interface Candidate {
  rid: number
  sessionId: string
  kind: SearchHitKind
  refId: string | null
  /** Higher is better within its pass. */
  score: number
  /** Present for fuzzy hits (snippet built in JS). */
  snippet?: string
  fuzzy: boolean
}

interface SessionLookupRow {
  id: string
  title: string
  mode_id: string | null
  started_at: number
  ended_at: number | null
  duration_ms: number | null
  status: SessionStatus
}

/** FTS5 candidates per query before grouping. Bounded so a one-letter query stays fast. */
const FTS_CANDIDATES = 2000
const TRIGRAM_CANDIDATES = 1000
const HITS_PER_SESSION = 3
const FUZZY_BELOW_SESSIONS = 3
const FUZZY_MIN_TOKEN_CHARS = 4

// Titles are the strongest signal, then the structured post-call outputs.
const KIND_WEIGHT_SQL = `(CASE kind WHEN 'title' THEN 2.0 WHEN 'notes' THEN 1.3
  WHEN 'action_item' THEN 1.2 ELSE 1.0 END)`

/**
 * Full-text search over titles, transcripts, notes, action items and follow-up emails, with a
 * trigram fallback for typos, plus retrieval of excerpts for "ask across meetings".
 * Never throws on user input: any SQLite error yields an empty result.
 */
export class SearchService {
  private readonly stmt: {
    fts: Statement
    snippets: Statement
    trigram: Statement
    sessionsByIds: Statement
    sessionForExcerpt: Statement
    sessionLines: Statement
    actionItem: Statement
    indexedText: Statement
  }

  constructor(
    private readonly db: Db,
    private readonly log?: Logger,
  ) {
    this.stmt = {
      fts: db.prepare(
        `SELECT rowid AS rid, session_id, kind, ref_id, bm25(search_fts) * ${KIND_WEIGHT_SQL} AS score
         FROM search_fts WHERE search_fts MATCH ? ORDER BY score LIMIT ?`,
      ),
      snippets: db.prepare(
        `SELECT rowid AS rid, snippet(search_fts, 0, @markStart, @markEnd, '…', 12) AS snip
         FROM search_fts
         WHERE search_fts MATCH @match AND rowid IN (SELECT value FROM json_each(@ids))`,
      ),
      trigram: db.prepare(
        `SELECT rowid AS rid, session_id, kind, ref_id, text,
                bm25(search_trigram) * ${KIND_WEIGHT_SQL} AS score
         FROM search_trigram WHERE search_trigram MATCH ? ORDER BY score LIMIT ?`,
      ),
      sessionsByIds: db.prepare(
        `SELECT ${SESSION_SUMMARY_COLUMNS} FROM sessions
         WHERE id IN (SELECT value FROM json_each(?))`,
      ),
      sessionForExcerpt: db.prepare(
        'SELECT id, title, started_at, summary_json FROM sessions WHERE id = ?',
      ),
      sessionLines: db.prepare(
        `SELECT ${TRANSCRIPT_COLUMNS} FROM transcript_lines WHERE session_id = ? AND is_final = 1
         ORDER BY ${TRANSCRIPT_ORDER}`,
      ),
      actionItem: db.prepare('SELECT text, owner, due, done FROM action_items WHERE id = ?'),
      indexedText: db.prepare('SELECT text FROM search_fts WHERE rowid = ?'),
    }
  }

  /** See {@link looksLikeQuestion}. */
  looksLikeQuestion(q: string): boolean {
    return looksLikeQuestion(q)
  }

  /**
   * Searches everything. Groups hits by session (≤ 3 each); sessions are ordered by their best
   * hit, then by recency. `limit` caps the number of sessions. When the exact pass finds fewer
   * than 3 sessions, a trigram pass adds close matches and sets `fuzzy`.
   */
  query(q: string, limit = 50): SearchResult {
    const empty: SearchResult = {
      query: q,
      looksLikeQuestion: looksLikeQuestion(q),
      fuzzy: false,
      groups: [],
    }
    const tokens = tokenize(q)
    if (!tokens.length) return empty
    const maxGroups = Math.max(1, Math.min(200, Math.floor(limit) || 50))
    try {
      const match = buildFtsQuery(tokens)
      const exact = this.ftsCandidates(match, FTS_CANDIDATES)
      let groups = this.group(exact, maxGroups)
      let fuzzy = false
      // Typo tolerance: only when exact matching found few sessions (regardless of `limit`)
      // and a token is long enough to carry a typo.
      const exactSessions = new Set(exact.map((c) => c.sessionId)).size
      if (
        exactSessions < FUZZY_BELOW_SESSIONS &&
        tokens.some((t) => codePoints(t).length >= FUZZY_MIN_TOKEN_CHARS)
      ) {
        const seen = new Set(exact.map((c) => c.rid))
        const close = this.fuzzyCandidates(tokens).filter((c) => !seen.has(c.rid))
        if (close.length) {
          const merged = this.group([...exact, ...close], maxGroups)
          fuzzy = merged.some((g) => g.hits.some((h) => h.fuzzy))
          groups = merged
        }
      }
      return { ...empty, fuzzy, groups: this.finalizeGroups(groups, match) }
    } catch (err) {
      this.log?.warn('Search failed', err)
      return empty
    }
  }

  /**
   * Top excerpts for answering `question` from past meetings: exact matches on the topical
   * words (AND, then OR), then fuzzy ones. Transcript hits include ±2 neighbouring lines
   * labelled "Me:"/"Them:"; overlapping windows are merged; each excerpt is ≤ 800 chars.
   */
  retrieveForQuestion(question: string, k = 12): RetrievedExcerpt[] {
    const all = tokenize(question)
    if (!all.length || k <= 0) return []
    const topical = all.filter((t) => !STOPWORDS.has(t))
    const tokens = topical.length ? topical : all
    try {
      const pool = Math.min(FTS_CANDIDATES, k * 10)
      const candidates: Candidate[] = []
      const seen = new Set<number>()
      const add = (list: Candidate[]) => {
        for (const c of list) {
          if (seen.has(c.rid)) continue
          seen.add(c.rid)
          candidates.push(c)
        }
      }
      add(this.ftsCandidates(buildFtsQuery(tokens, 'AND'), pool))
      if (candidates.length < k && tokens.length > 1) {
        add(this.ftsCandidates(buildFtsQuery(tokens, 'OR'), pool))
      }
      if (
        candidates.length < k &&
        tokens.some((t) => codePoints(t).length >= FUZZY_MIN_TOKEN_CHARS)
      ) {
        add(this.fuzzyCandidates(tokens))
      }
      return this.buildExcerpts(candidates, tokens, k)
    } catch (err) {
      this.log?.warn('Retrieval failed', err)
      return []
    }
  }

  // ── internals ──

  private ftsCandidates(match: string, max: number): Candidate[] {
    return (this.stmt.fts.all(match, max) as FtsRow[]).map((r) => ({
      rid: r.rid,
      sessionId: r.session_id,
      kind: r.kind,
      refId: r.ref_id,
      score: -r.score,
      fuzzy: false,
    }))
  }

  private fuzzyCandidates(tokens: string[]): Candidate[] {
    const fuzzyTokens = tokens.filter((t) => codePoints(t).length >= 3)
    if (!fuzzyTokens.length) return []
    const rows = this.stmt.trigram.all(
      buildTrigramQuery(fuzzyTokens),
      TRIGRAM_CANDIDATES,
    ) as TrigramRow[]
    const out: Candidate[] = []
    for (const r of rows) {
      const text = r.text.replaceAll(SNIPPET_MARK_START, '').replaceAll(SNIPPET_MARK_END, '')
      const m = fuzzyMatch(text, tokens)
      if (!m) continue
      out.push({
        rid: r.rid,
        sessionId: r.session_id,
        kind: r.kind,
        refId: r.ref_id,
        // Trigram share (0.4..1) dominates; bm25 (negative, lower is better) only breaks ties.
        score: m.share - r.score / 1000,
        snippet: buildSnippet(text, m.words, m.marked),
        fuzzy: true,
      })
    }
    out.sort((a, b) => b.score - a.score)
    return out
  }

  /**
   * Groups candidates by session. Candidates arrive best-first per pass (exact before fuzzy),
   * so a session's first candidate is its best hit. Sessions with an exact hit come first,
   * ordered by best score; ties fall back to recency.
   */
  private group(candidates: Candidate[], maxGroups: number): CandidateGroup[] {
    const bySession = new Map<string, CandidateGroup>()
    for (const c of candidates) {
      let g = bySession.get(c.sessionId)
      if (!g) {
        g = { sessionId: c.sessionId, best: c, hits: [], session: null }
        bySession.set(c.sessionId, g)
      }
      if (g.hits.length < HITS_PER_SESSION) g.hits.push(c)
    }
    if (!bySession.size) return []
    const sessions = this.loadSessions([...bySession.keys()])
    const groups: CandidateGroup[] = []
    for (const g of bySession.values()) {
      const session = sessions.get(g.sessionId)
      // Index rows can briefly outlive a session deleted by another statement; skip them.
      if (session) groups.push({ ...g, session })
    }
    groups.sort((a, b) => {
      if (a.best.fuzzy !== b.best.fuzzy) return a.best.fuzzy ? 1 : -1
      if (a.best.score !== b.best.score) return b.best.score - a.best.score
      return (b.session?.startedAt ?? 0) - (a.session?.startedAt ?? 0)
    })
    return groups.slice(0, maxGroups)
  }

  private finalizeGroups(groups: CandidateGroup[], match: string): SearchGroup[] {
    const exactIds = groups.flatMap((g) => g.hits.filter((h) => !h.fuzzy).map((h) => h.rid))
    const snippets = new Map<number, string>()
    if (exactIds.length) {
      const rows = this.stmt.snippets.all({
        markStart: SNIPPET_MARK_START,
        markEnd: SNIPPET_MARK_END,
        match,
        ids: JSON.stringify(exactIds),
      }) as { rid: number; snip: string }[]
      for (const r of rows) snippets.set(r.rid, r.snip)
    }
    const out: SearchGroup[] = []
    for (const g of groups) {
      if (!g.session) continue
      out.push({
        session: g.session,
        hits: g.hits.map((h): SearchHit => ({
          sessionId: h.sessionId,
          kind: h.kind,
          refId: h.refId,
          snippet: (h.fuzzy ? h.snippet : snippets.get(h.rid)) ?? '',
          score: h.score,
        })),
      })
    }
    return out
  }

  private loadSessions(ids: string[]): Map<string, SessionSummary> {
    const rows = this.stmt.sessionsByIds.all(JSON.stringify(ids)) as SessionLookupRow[]
    return new Map(rows.map((r) => [r.id, mapSessionRow(r)]))
  }

  private buildExcerpts(candidates: Candidate[], tokens: string[], k: number): RetrievedExcerpt[] {
    type Window = {
      sessionId: string
      lines: TranscriptRow[]
      from: number
      to: number
      hits: Set<number>
    }
    type Item =
      | { type: 'window'; w: Window }
      | { type: 'text'; sessionId: string; kind: SearchHitKind; text: string }
    const items: Item[] = []
    const lineCache = new Map<string, TranscriptRow[]>()
    const linesOf = (sessionId: string): TranscriptRow[] => {
      let lines = lineCache.get(sessionId)
      if (!lines) {
        lines = this.stmt.sessionLines.all(sessionId) as TranscriptRow[]
        lineCache.set(sessionId, lines)
      }
      return lines
    }
    const seenRefs = new Set<string>()

    for (const c of candidates) {
      if (c.kind === 'transcript') {
        const lines = linesOf(c.sessionId)
        const idx = lines.findIndex((l) => l.id === c.refId)
        if (idx < 0) continue
        let w: Window = {
          sessionId: c.sessionId,
          lines,
          from: Math.max(0, idx - NEIGHBOUR_LINES),
          to: Math.min(lines.length - 1, idx + NEIGHBOUR_LINES),
          hits: new Set([idx]),
        }
        // Merge with every window of the same session it overlaps or touches.
        let merged = false
        for (let i = 0; i < items.length; i++) {
          const it = items[i]
          if (it?.type !== 'window' || it.w.sessionId !== w.sessionId) continue
          if (w.from > it.w.to + 1 || w.to < it.w.from - 1) continue
          if (!merged) {
            it.w.from = Math.min(it.w.from, w.from)
            it.w.to = Math.max(it.w.to, w.to)
            for (const h of w.hits) it.w.hits.add(h)
            w = it.w
            merged = true
          } else {
            // A later window bridged two earlier ones: fold it into the first and drop it.
            w.from = Math.min(w.from, it.w.from)
            w.to = Math.max(w.to, it.w.to)
            for (const h of it.w.hits) w.hits.add(h)
            items.splice(i, 1)
            i--
          }
        }
        if (!merged && items.length < k) items.push({ type: 'window', w })
      } else {
        const key = `${c.kind}:${c.refId ?? c.rid}`
        if (seenRefs.has(key) || items.length >= k) continue
        seenRefs.add(key)
        const text = this.hitText(c, tokens)
        if (text) items.push({ type: 'text', sessionId: c.sessionId, kind: c.kind, text })
      }
    }

    const sessionCache = new Map<string, { title: string; startedAt: number } | null>()
    const sessionOf = (id: string) => {
      if (!sessionCache.has(id)) {
        const row = this.stmt.sessionForExcerpt.get(id) as
          { title: string; started_at: number } | undefined
        sessionCache.set(
          id,
          row ? { title: row.title.trim() || ht('untitled'), startedAt: row.started_at } : null,
        )
      }
      return sessionCache.get(id) ?? null
    }

    const out: RetrievedExcerpt[] = []
    for (const it of items) {
      const sessionId = it.type === 'window' ? it.w.sessionId : it.sessionId
      const s = sessionOf(sessionId)
      if (!s) continue
      out.push({
        sessionId,
        title: s.title,
        startedAt: s.startedAt,
        kind: it.type === 'window' ? 'transcript' : it.kind,
        text: it.type === 'window' ? renderWindow(it.w) : it.text,
      })
    }
    return out
  }

  private hitText(c: Candidate, tokens: string[]): string {
    if (c.kind === 'action_item' && c.refId) {
      const row = this.stmt.actionItem.get(c.refId) as
        { text: string; owner: string | null; due: string | null; done: number } | undefined
      if (!row) return ''
      const extra = [row.owner, row.due].filter(Boolean).join(', ')
      return hardCap(
        `${row.done ? '[x]' : '[ ]'} ${row.text}${extra ? ` (${extra})` : ''}`,
        EXCERPT_MAX_CHARS,
      )
    }
    if (c.kind === 'title') {
      const row = this.stmt.sessionForExcerpt.get(c.sessionId) as
        { title: string; summary_json: string | null } | undefined
      if (!row) return ''
      const summary = parseSummaryJson(row.summary_json).notes?.summary?.trim()
      return hardCap(summary ? `${row.title}\n${summary}` : row.title, EXCERPT_MAX_CHARS)
    }
    // Notes and email hits: the stored markdown, cut around the match.
    const row = this.stmt.indexedText.get(c.rid) as { text: string } | undefined
    return row ? excerptAround(row.text, tokens) : ''
  }
}

interface CandidateGroup {
  sessionId: string
  /** First (= best) candidate of the session. */
  best: Candidate
  hits: Candidate[]
  session: SessionSummary | null
}

/** Renders a transcript window, dropping outer context lines first when over the cap. */
function renderWindow(w: {
  lines: TranscriptRow[]
  from: number
  to: number
  hits: Set<number>
}): string {
  const fmt = (i: number) => {
    const l = w.lines[i]
    return l ? `${SPEAKER[l.channel]}: ${l.text.trim()}` : ''
  }
  const minHit = Math.min(...w.hits)
  const maxHit = Math.max(...w.hits)
  let a = w.from
  let b = w.to
  const length = () => {
    let n = 0
    for (let i = a; i <= b; i++) n += fmt(i).length + 1
    return n - 1
  }
  while (length() > EXCERPT_MAX_CHARS && (a < minHit || b > maxHit)) {
    const before = minHit - a
    const after = b - maxHit
    if (before >= after && a < minHit) a++
    else if (b > maxHit) b--
    else a++
  }
  const parts: string[] = []
  for (let i = a; i <= b; i++) parts.push(fmt(i))
  return hardCap(parts.join('\n'), EXCERPT_MAX_CHARS)
}
