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
const WORD_CHAR_RE = /[\p{L}\p{N}\p{M}]/u
const EDGE_JOINERS_RE = /^[\u200c\u200d]+|[\u200c\u200d]+$/g
const APOSTROPHES = new Set(["'", '\u2019', '\u02bc'])
/** English contractions and possessives: "acme's", "don't", "we'll", "they're", "I've", "I'd", "I'm". */
const CLITICS = new Set(['s', 't', 'll', 're', 've', 'd', 'm'])

/**
 * Splits user input into lower-case search tokens (max 8, de-duplicated). Everything that is
 * not a letter, digit or mark is a separator, which is what makes FTS5 syntax inert:
 * quotes, operators, `*`, `^`, `col:` and parentheses never reach the MATCH expression.
 *
 * Every token must match, so pieces that carry no meaning are dropped: an English clitic after
 * an apostrophe ("acme's" → acme), and one-character tokens when a longer one exists
 * ("e-mail" → mail). A one-character prefix also matches nearly every row and has no prefix
 * index, which made such queries freeze the main process for seconds on a large history.
 */
export function tokenize(input: string): string[] {
  const text = input.normalize('NFC').toLowerCase()
  const all: string[] = []
  const seen = new Set<string>()
  for (const m of text.matchAll(TOKEN_RE)) {
    const tok = m[0].replace(EDGE_JOINERS_RE, '')
    if (!tok || !HAS_BASE_CHAR_RE.test(tok) || seen.has(tok)) continue
    if (CLITICS.has(tok) && isAfterApostropheInWord(text, m.index)) continue
    seen.add(tok)
    all.push(tok)
  }
  const long = all.filter((t) => codePoints(t).length > 1)
  return (long.length ? long : all).slice(0, MAX_TOKENS)
}

function isAfterApostropheInWord(text: string, index: number): boolean {
  return (
    index >= 2 && APOSTROPHES.has(text[index - 1] ?? '') && WORD_CHAR_RE.test(text[index - 2] ?? '')
  )
}

function quote(token: string): string {
  return `"${token.replace(/"/g, '""')}"`
}

/** Prefix match for every token: `"tok1"* AND "tok2"*` (or OR-joined). */
export function buildFtsQuery(tokens: string[], op: 'AND' | 'OR' = 'AND'): string {
  return tokens.map((t) => `${quote(t)}*`).join(` ${op} `)
}

/**
 * True when the query is only one-character tokens, e.g. "Q&A" or "a b": these are searched as
 * one adjacent phrase ("Q&A" is indexed as the tokens q, a) instead of as unrelated prefixes.
 */
export function isLetterRun(tokens: string[]): boolean {
  return tokens.length > 1 && tokens.every((t) => codePoints(t).length === 1)
}

/** `"q" + "a"*`: the tokens next to each other, the last one as a prefix. */
export function buildPhraseQuery(tokens: string[]): string {
  return `${tokens.map(quote).join(' + ')}*`
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

type TokenMatch = { idx: number; share: number } | null

/**
 * Matches each token on its own against the words of `text`: a token with ≥ 3 characters must
 * share ≥ 40 % of its trigrams with a single word (comparing per word keeps long notes from
 * matching on scattered trigrams), a shorter one must prefix some word. Returns, per token, the
 * matched word and its trigram share (1 for prefix-only tokens), or null.
 */
function matchTokens(words: Word[], tokens: string[]): TokenMatch[] {
  return tokens.map((token): TokenMatch => {
    const tris = trigramsOf(token)
    if (!tris.length) {
      const idx = words.findIndex((w) => w.lower.startsWith(token))
      return idx < 0 ? null : { idx, share: 1 }
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
    return best < FUZZY_MIN_TRIGRAM_SHARE ? null : { idx: bestIdx, share: best }
  })
}

/** Mean trigram share of the matched tokens that have trigrams (1 when none). */
function meanFuzzyShare(tokens: string[], matches: TokenMatch[]): number {
  let sum = 0
  let n = 0
  tokens.forEach((t, i) => {
    const m = matches[i]
    if (!m || codePoints(t).length < 3) return
    sum += m.share
    n++
  })
  return n ? sum / n : 1
}

/** Typo-tolerant check done in JS on the hit text: every token must match (see matchTokens). */
export function fuzzyMatch(text: string, tokens: string[]): FuzzyMatch | null {
  const words = wordsOf(text)
  if (!words.length) return null
  const matches = matchTokens(words, tokens)
  const marked = new Set<number>()
  for (const m of matches) {
    if (!m) return null
    marked.add(m.idx)
  }
  return { share: meanFuzzyShare(tokens, matches), marked, words }
}

// unicode61 with remove_diacritics folds case and Latin diacritics (café → cafe); combining
// marks of other scripts (Bangla vowel signs) stay part of the token.
const LATIN_DIACRITICS_RE = /[̀-ͯ]/g
const JOINERS_RE = /[‌‍]/

/** Approximates the FTS tokenizer's folding so highlights land on the words FTS matched. */
export function foldForMatch(word: string): string {
  return word.normalize('NFD').replace(LATIN_DIACRITICS_RE, '').normalize('NFC').toLowerCase()
}

const NON_ASCII_RE = /[\u0080-\uffff]/

/** {@link foldForMatch} for a whole text; plain ASCII only needs lower-casing. */
function foldText(text: string): string {
  return NON_ASCII_RE.test(text) ? foldForMatch(text) : text.toLowerCase()
}

/**
 * True when `token` starts a word of a folded text, as for the FTS prefix query `"token"*`
 * (FTS words are runs of letters, digits, marks and private-use characters). A plain
 * substring check rules out most texts before the regex runs.
 */
function wordPrefixMatcher(token: string): (folded: string) => boolean {
  const folded = foldForMatch(token)
  const literal = folded.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(?<![\\p{L}\\p{N}\\p{M}\\p{Co}])${literal}`, 'u')
  return (text) => text.includes(folded) && re.test(text)
}

function stripMarks(text: string): string {
  return text.replaceAll(SNIPPET_MARK_START, '').replaceAll(SNIPPET_MARK_END, '')
}

/**
 * Highlighted snippet for an exact (FTS) hit, built from the stored text: words that start with
 * a query token are marked. Built in JS because FTS5 snippet() re-runs the MATCH for every hit,
 * which took seconds for short prefixes on a large history.
 */
export function prefixSnippet(rawText: string, tokens: string[]): string {
  const text = stripMarks(rawText)
  const folded = tokens.map(foldForMatch)
  const words = wordsOf(text)
  const marked = new Set<number>()
  words.forEach((w, i) => {
    const word = foldForMatch(text.slice(w.start, w.end))
    // FTS splits words at ZWNJ/ZWJ, so a token may also start inside a joined word.
    const parts = [word, ...word.split(JOINERS_RE).slice(1)]
    if (folded.some((t) => parts.some((p) => p.startsWith(t)))) marked.add(i)
  })
  return buildSnippet(text, words, marked)
}

const SNIPPET_WORDS = 12

/** Builds a highlighted snippet like FTS5 snippet(): ~12 words around the first match. */
export function buildSnippet(text: string, words: Word[], marked: Set<number>): string {
  if (!words.length) return text.slice(0, 200)
  const first = marked.size ? Math.min(...marked) : 0
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

interface WordRow {
  rid: number
  session_id: string
  kind: SearchHitKind
  ref_id: string | null
}

interface ItemRow {
  rid: number
  kind: SearchHitKind
  ref_id: string | null
  text: string | null
}

/**
 * How a session matched, best first: all words in one row (FTS AND); all words somewhere in the
 * meeting, across rows; then the same two for typo (trigram) matches.
 */
const TIER_ROW = 0
const TIER_SESSION = 1
const TIER_FUZZY_ROW = 2
const TIER_FUZZY_SESSION = 3

interface Candidate {
  rid: number
  sessionId: string
  kind: SearchHitKind
  refId: string | null
  /** Higher is better within its tier. */
  score: number
  /** Present for fuzzy hits (built from the trigram row); exact snippets are built at the end. */
  snippet?: string
  fuzzy: boolean
  tier: number
}

interface SessionMatch {
  sessionId: string
  /** Score of the session's best hit. */
  best: number
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
const KIND_WEIGHT: Record<SearchHitKind, number> = {
  title: 2.0,
  notes: 1.3,
  action_item: 1.2,
  email: 1.0,
  transcript: 1.0,
}
const KIND_WEIGHT_SQL = `(CASE kind ${Object.entries(KIND_WEIGHT)
  .map(([kind, w]) => `WHEN '${kind}' THEN ${w.toFixed(1)}`)
  .join(' ')} ELSE 1.0 END)`

/**
 * A meeting's indexed items, one statement per kind in KIND_WEIGHT order (best first). `rid`
 * is the item's search index rowid: source rowid * 8 + tag, as the triggers in migrations.ts
 * write it.
 */
const SESSION_ITEMS_SQL = [
  `SELECT rowid * 8 + 1 AS rid, 'title' AS kind, id AS ref_id, title AS text
   FROM sessions WHERE id = ?`,
  `SELECT rowid * 8 + 3 AS rid, 'notes' AS kind, id AS ref_id, response_text AS text
   FROM ai_messages WHERE session_id = ? AND kind = 'post_notes' AND response_text IS NOT NULL`,
  `SELECT rowid * 8 + 4 AS rid, 'action_item' AS kind, id AS ref_id, text
   FROM action_items WHERE session_id = ?`,
  `SELECT rowid * 8 + 5 AS rid, 'email' AS kind, id AS ref_id, response_text AS text
   FROM ai_messages WHERE session_id = ? AND kind = 'post_email' AND response_text IS NOT NULL`,
  `SELECT rowid * 8 + 2 AS rid, 'transcript' AS kind, id AS ref_id, text
   FROM transcript_lines WHERE session_id = ? AND is_final = 1`,
]

/** Per-query work limits for matching words anywhere in a meeting, in rows read. */
export interface SessionMatchLimits {
  /** Index rows read to map words to the meetings that contain them (rarest words first). */
  mapRows: number
  /** Items of candidate meetings read to find the words that were too common to map. */
  scanRows: number
}

/**
 * Each is roughly 10 ms of main-process work, whatever the size of the history (measured on a
 * synthetic history of 260 meetings × 600 lines).
 */
export const SESSION_MATCH_LIMITS: Readonly<SessionMatchLimits> = {
  mapRows: 5000,
  scanRows: 5000,
}

/** Words are counted up to this many times `mapRows` (see SessionWords.count). */
const COUNT_CAP_FACTOR = 2

/** Returned when the scan budget ran out before a meeting could be decided. */
const EXHAUSTED = 'exhausted'

interface SessionWordStatements {
  countUpTo: Statement
  wordRows: Statement
  sessionItems: Statement[]
}

/**
 * Answers "which meetings contain this word, and in which item?" for the words of one query,
 * with a bounded amount of work. Mapping a word to its meetings reads every index row of the
 * word, which for everyday words ("the", "is") is most of the index: a long query of such
 * words took ~0.4 s on a 156k-line history, blocking the main process. So words are mapped
 * (rarest first) only while the rows read stay within `limits.mapRows`; the remaining, more
 * common words are looked for in each candidate meeting's own items, best kind first, which
 * finds a common word within a few items, within `limits.scanRows`.
 */
class SessionWords {
  private readonly counts = new Map<number, number>()
  private readonly maps = new Map<number, Map<string, Candidate> | null>()
  private readonly matchers = new Map<number, (folded: string) => boolean>()
  private mapRows: number
  private scanRows: number

  constructor(
    private readonly stmt: SessionWordStatements,
    private readonly tokens: string[],
    private readonly limits: SessionMatchLimits,
  ) {
    this.mapRows = limits.mapRows
    this.scanRows = limits.scanRows
  }

  /**
   * Index rows containing word i, counted up to a few times what mapping may read: enough to
   * tell the rarest of several common words apart, while counting stays index-only and cheap.
   */
  count(i: number): number {
    let n = this.counts.get(i)
    if (n === undefined) {
      const cap = COUNT_CAP_FACTOR * this.limits.mapRows + 1
      n = (this.stmt.countUpTo.get(this.match(i), cap) as { c: number }).c
      this.counts.set(i, n)
    }
    return n
  }

  /** Word indexes, rarest first; on a tie (also past the count cap), the longer word. */
  byRarity(): number[] {
    const length = (i: number) => codePoints(this.tokens[i] ?? '').length
    return this.tokens
      .map((_, i) => i)
      .sort((a, b) => this.count(a) - this.count(b) || length(b) - length(a))
  }

  /** Every meeting that contains word i, with its best item; null when over the budget. */
  map(i: number): Map<string, Candidate> | null {
    let map = this.maps.get(i)
    if (map === undefined) {
      map = this.count(i) <= this.mapRows ? this.readRows(i, this.mapRows) : null
      this.maps.set(i, map)
    }
    return map
  }

  /**
   * For a word too common to {@link map}: the meetings of its most recent rows, as many as the
   * rest of the budget reads (it is used up), each with the best of those rows.
   */
  recent(i: number): Map<string, Candidate> {
    return this.readRows(i, this.mapRows)
  }

  /**
   * The best item of `sessionId` for each word in `indexes` (same order): from the word's map
   * when mapping it is affordable, otherwise by {@link scan}. null when a word is not in the
   * meeting; EXHAUSTED when the scan budget ran out before that was known.
   */
  hitsIn(sessionId: string, indexes: number[]): Candidate[] | null | typeof EXHAUSTED {
    const hits = new Map<number, Candidate>()
    const unmapped: number[] = []
    for (const i of indexes) {
      const map = this.map(i)
      if (!map) {
        unmapped.push(i)
        continue
      }
      const hit = map.get(sessionId)
      if (!hit) return null
      hits.set(i, hit)
    }
    const scanned = unmapped.length ? this.scan(sessionId, unmapped) : []
    if (scanned === null || scanned === EXHAUSTED) return scanned
    scanned.forEach((hit, k) => hits.set(unmapped[k] ?? -1, hit))
    return indexes.flatMap((i) => hits.get(i) ?? [])
  }

  /**
   * Reads the items of `sessionId`, best kind first, until each word in `indexes` has turned
   * up; returns each word's first item (same order). null when a word is not in the meeting;
   * EXHAUSTED when the scan budget ran out first.
   */
  scan(sessionId: string, indexes: number[]): Candidate[] | null | typeof EXHAUSTED {
    const matchers = indexes.map((i) => this.matcher(i))
    const hits: (Candidate | undefined)[] = indexes.map(() => undefined)
    let left = indexes.length
    for (const stmt of this.stmt.sessionItems) {
      for (const row of stmt.iterate(sessionId) as IterableIterator<ItemRow>) {
        if (this.scanRows <= 0) return EXHAUSTED
        this.scanRows--
        const text = foldText(row.text ?? '')
        matchers.forEach((matches, k) => {
          if (hits[k] || !matches(text)) return
          hits[k] = sessionHit(sessionId, row)
          left--
        })
        if (!left) return hits.flatMap((h) => h ?? [])
      }
    }
    return null
  }

  private match(i: number): string {
    return buildFtsQuery([this.tokens[i] ?? ''])
  }

  private matcher(i: number): (folded: string) => boolean {
    let matches = this.matchers.get(i)
    if (!matches) {
      matches = wordPrefixMatcher(this.tokens[i] ?? '')
      this.matchers.set(i, matches)
    }
    return matches
  }

  /** Up to `limit` rows of word i, newest first, as each meeting's best item (by kind). */
  private readRows(i: number, limit: number): Map<string, Candidate> {
    const rows = this.stmt.wordRows.all(this.match(i), Math.max(0, limit)) as WordRow[]
    this.mapRows -= rows.length
    const out = new Map<string, Candidate>()
    for (const r of rows) {
      const hit = sessionHit(r.session_id, r)
      const prev = out.get(r.session_id)
      if (!prev || hit.score > prev.score) out.set(r.session_id, hit)
    }
    return out
  }
}

function sessionHit(
  sessionId: string,
  r: { rid: number; kind: SearchHitKind; ref_id: string | null },
): Candidate {
  return {
    rid: r.rid,
    sessionId,
    kind: r.kind,
    refId: r.ref_id,
    score: KIND_WEIGHT[r.kind] ?? 1,
    fuzzy: false,
    tier: TIER_SESSION,
  }
}

/**
 * Full-text search over titles, transcripts, notes, action items and follow-up emails, with a
 * trigram fallback for typos, plus retrieval of excerpts for "ask across meetings".
 * Never throws on user input: any SQLite error yields an empty result.
 */
export class SearchService {
  private readonly stmt: SessionWordStatements & {
    fts: Statement
    trigram: Statement
    sessionsByIds: Statement
    startedAt: Statement
    sessionForExcerpt: Statement
    sessionLines: Statement
    actionItem: Statement
    indexedText: Statement
  }

  constructor(
    private readonly db: Db,
    private readonly log?: Logger,
    private readonly limits: SessionMatchLimits = SESSION_MATCH_LIMITS,
  ) {
    this.stmt = {
      fts: db.prepare(
        `SELECT rowid AS rid, session_id, kind, ref_id, bm25(search_fts) * ${KIND_WEIGHT_SQL} AS score
         FROM search_fts WHERE search_fts MATCH ? ORDER BY score LIMIT ?`,
      ),
      // Index-only (no row reads), and stops at the limit, so cheap even for "the".
      countUpTo: db.prepare(
        'SELECT count(*) AS c FROM (SELECT 1 FROM search_fts WHERE search_fts MATCH ? LIMIT ?)',
      ),
      // Newest first, so a capped read keeps the most recent meetings.
      wordRows: db.prepare(
        `SELECT rowid AS rid, session_id, kind, ref_id
         FROM search_fts WHERE search_fts MATCH ? ORDER BY rowid DESC LIMIT ?`,
      ),
      sessionItems: SESSION_ITEMS_SQL.map((sql) => db.prepare(sql)),
      trigram: db.prepare(
        `SELECT rowid AS rid, session_id, kind, ref_id, text,
                bm25(search_trigram) * ${KIND_WEIGHT_SQL} AS score
         FROM search_trigram WHERE search_trigram MATCH ? ORDER BY score LIMIT ?`,
      ),
      sessionsByIds: db.prepare(
        `SELECT ${SESSION_SUMMARY_COLUMNS} FROM sessions
         WHERE id IN (SELECT value FROM json_each(?))`,
      ),
      startedAt: db.prepare(
        'SELECT id, started_at FROM sessions WHERE id IN (SELECT value FROM json_each(?))',
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
   * Searches everything. A meeting matches when every word occurs in it: first meetings with
   * all words in one item (a line, the title, the notes…), then meetings where the words are
   * spread over several items. Groups hits by session (≤ 3 each); within each of those tiers
   * sessions are ordered by their best hit, then by recency. `limit` caps the number of
   * sessions. When the exact passes find fewer than 3 sessions, a trigram pass adds close
   * matches and sets `fuzzy`. Matching words across a meeting's items does a bounded amount
   * of work (see SessionWords): on a very large history, meetings matched that way may be
   * limited to the most recent ones.
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
      const phrase = isLetterRun(tokens)
      const candidates = this.ftsCandidates(
        phrase ? buildPhraseQuery(tokens) : buildFtsQuery(tokens),
        FTS_CANDIDATES,
      )
      const found = new Set(candidates.map((c) => c.sessionId))
      const words = new SessionWords(this.stmt, tokens, this.limits)
      // Session-level matches rank after every single-row match, so they are only needed
      // while those leave room in the result.
      if (!phrase && tokens.length > 1 && found.size < maxGroups) {
        for (const c of this.spreadCandidates(found, maxGroups - found.size, words)) {
          candidates.push(c)
          found.add(c.sessionId)
        }
      }
      // Typo tolerance: only when exact matching found few sessions (regardless of `limit`)
      // and a token is long enough to carry a typo.
      if (
        found.size < FUZZY_BELOW_SESSIONS &&
        tokens.some((t) => codePoints(t).length >= FUZZY_MIN_TOKEN_CHARS)
      ) {
        const seen = new Set(candidates.map((c) => c.rid))
        const close = this.fuzzyCandidates(tokens, phrase ? undefined : { found, words })
        candidates.push(...close.filter((c) => !seen.has(c.rid)))
      }
      const groups = this.group(candidates, maxGroups)
      const fuzzy = groups.some((g) => g.hits.some((h) => h.fuzzy))
      return { ...empty, fuzzy, groups: this.finalizeGroups(groups, tokens) }
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
      tier: TIER_ROW,
    }))
  }

  /**
   * Up to `need` sessions that contain every token somewhere (title, any line, notes, action
   * items, email) but were not found by the single-row pass, e.g. "acme" in the title and
   * "pricing" said in a line. Hits are each token's best item in the session. The rarest word
   * proposes sessions and each word that is cheap to map narrows them down (see SessionWords);
   * the other words are looked for in each remaining session, most promising first (best hit
   * so far, then recency), while the budget lasts.
   */
  private spreadCandidates(
    found: ReadonlySet<string>,
    need: number,
    words: SessionWords,
  ): Candidate[] {
    const [rarest, ...others] = words.byRarity()
    if (rarest === undefined || words.count(rarest) === 0) return []
    const all = words.map(rarest)
    const proposed = all ?? words.recent(rarest)
    const mapped = all ? [all] : []
    // Only its newest rows were read, so its best item (e.g. the title) is looked up instead.
    const unmapped = all ? [] : [rarest]
    let sessions = [...proposed.keys()].filter((s) => !found.has(s))
    for (const i of others) {
      if (!sessions.length || words.count(i) === 0) return []
      const map = words.map(i)
      if (!map) {
        unmapped.push(i)
        continue
      }
      mapped.push(map)
      sessions = sessions.filter((s) => map.has(s))
    }
    const startedAt = this.startedAt(sessions)
    const byRank = (a: SessionMatch, b: SessionMatch) =>
      b.best - a.best || (startedAt.get(b.sessionId) ?? 0) - (startedAt.get(a.sessionId) ?? 0)
    const ordered = sessions
      .map((sessionId) => ({
        sessionId,
        best: Math.max(...[proposed, ...mapped].map((m) => m.get(sessionId)?.score ?? 0)),
      }))
      .sort(byRank)
    const matches: (SessionMatch & { hits: Candidate[] })[] = []
    for (const { sessionId } of ordered) {
      // With every word mapped, this order is final; otherwise a scan can still find a better
      // item (a common word in the title), so keep going while the budget lasts, then rank.
      if (!unmapped.length && matches.length >= need) break
      const rest = unmapped.length ? words.scan(sessionId, unmapped) : []
      if (rest === EXHAUSTED) break
      if (!rest) continue
      const hits = new Map<number, Candidate>()
      for (const c of [...mapped.map((m) => m.get(sessionId)), ...rest]) {
        if (c && !hits.has(c.rid)) hits.set(c.rid, c)
      }
      const list = [...hits.values()].sort((a, b) => b.score - a.score)
      matches.push({ sessionId, best: list[0]?.score ?? 0, hits: list })
    }
    return matches
      .sort(byRank)
      .slice(0, need)
      .flatMap((m) => m.hits)
  }

  private startedAt(ids: string[]): Map<string, number> {
    if (!ids.length) return new Map()
    const rows = this.stmt.startedAt.all(JSON.stringify(ids)) as {
      id: string
      started_at: number
    }[]
    return new Map(rows.map((r) => [r.id, r.started_at]))
  }

  /**
   * Typo-tolerant candidates from the trigram index, best first: rows in which every token
   * matches. With `spread`, also sessions whose rows match the tokens between them, where a
   * token may also be covered by an exact match elsewhere in the session (e.g. "entreprise"
   * in one line and "sso" in another), looked up within the SessionWords budget.
   */
  private fuzzyCandidates(
    tokens: string[],
    spread?: { found: ReadonlySet<string>; words: SessionWords },
  ): Candidate[] {
    const fuzzyTokens = tokens.filter((t) => codePoints(t).length >= 3)
    if (!fuzzyTokens.length) return []
    const rows = this.stmt.trigram.all(
      buildTrigramQuery(fuzzyTokens),
      TRIGRAM_CANDIDATES,
    ) as TrigramRow[]
    const out: Candidate[] = []
    const partial = new Map<string, { cand: Candidate; matched: number[] }[]>()
    for (const r of rows) {
      const text = stripMarks(r.text)
      const words = wordsOf(text)
      if (!words.length) continue
      const matches = matchTokens(words, tokens)
      const matched = tokens.map((_, i) => i).filter((i) => matches[i])
      if (!matched.length) continue
      const all = matched.length === tokens.length
      if (!all && (!spread || spread.found.has(r.session_id))) continue
      const cand: Candidate = {
        rid: r.rid,
        sessionId: r.session_id,
        kind: r.kind,
        refId: r.ref_id,
        // Trigram share (0.4..1) dominates; bm25 (negative, lower is better) only breaks ties.
        score: meanFuzzyShare(tokens, matches) - r.score / 1000,
        snippet: buildSnippet(text, words, new Set(matched.map((i) => matches[i]?.idx ?? -1))),
        fuzzy: true,
        tier: all ? TIER_FUZZY_ROW : TIER_FUZZY_SESSION,
      }
      if (all) out.push(cand)
      else partial.set(r.session_id, [...(partial.get(r.session_id) ?? []), { cand, matched }])
    }
    out.sort((a, b) => b.score - a.score)
    if (!spread) return out

    const rowLevel = new Set(out.map((c) => c.sessionId))
    for (const [sessionId, list] of partial) {
      if (rowLevel.has(sessionId)) continue
      const covered = new Set(list.flatMap((p) => p.matched))
      const missing = tokens.map((_, i) => i).filter((i) => !covered.has(i))
      const exact = spread.words.hitsIn(sessionId, missing)
      if (exact === EXHAUSTED) break
      if (!exact) continue
      const fuzzyHits = list.map((p) => p.cand).sort((a, b) => b.score - a.score)
      const rids = new Set(fuzzyHits.map((c) => c.rid))
      out.push(...fuzzyHits)
      for (const c of exact) {
        if (rids.has(c.rid)) continue
        rids.add(c.rid)
        out.push(c)
      }
    }
    return out
  }

  /**
   * Groups candidates by session. Candidates arrive best-first per tier, so a session's first
   * candidate is its best hit. Sessions are ordered by the tier of that hit, then by its
   * score; ties fall back to recency.
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
      if (a.best.tier !== b.best.tier) return a.best.tier - b.best.tier
      if (a.best.score !== b.best.score) return b.best.score - a.best.score
      return (b.session?.startedAt ?? 0) - (a.session?.startedAt ?? 0)
    })
    return groups.slice(0, maxGroups)
  }

  private finalizeGroups(groups: CandidateGroup[], tokens: string[]): SearchGroup[] {
    const out: SearchGroup[] = []
    for (const g of groups) {
      if (!g.session) continue
      out.push({
        session: g.session,
        hits: g.hits.map((h): SearchHit => ({
          sessionId: h.sessionId,
          kind: h.kind,
          refId: h.refId,
          snippet: (h.fuzzy ? h.snippet : this.exactSnippet(h.rid, tokens)) ?? '',
          score: h.score,
        })),
      })
    }
    return out
  }

  /** See {@link prefixSnippet}; the text comes from the index row (one rowid lookup). */
  private exactSnippet(rid: number, tokens: string[]): string {
    const row = this.stmt.indexedText.get(rid) as { text: string } | undefined
    return row ? prefixSnippet(row.text, tokens) : ''
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
