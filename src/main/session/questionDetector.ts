/**
 * Fast, local question detector. Runs on every finalized "Them" line to decide whether the
 * other person just asked something (auto-suggest), so it is pure, synchronous and cheap:
 * no model, no network.
 *
 * Approach: only the LAST sentence of a line decides (people give context first: "We tried
 * that already. How would you approach it"). Cues, strongest first: a terminal question mark;
 * request phrases ("walk me through"); interrogatives and auxiliaries at the start of the
 * sentence or of a later clause, checked for subject inversion so subordinate clauses
 * ("When we launched, it was great") and imperatives ("Do it now") don't count; tag questions
 * (", right"); and for languages whose question words sit anywhere in the clause (Bangla), the
 * interrogative anywhere plus sentence-final particles. Statement punctuation (".", "।", "!")
 * lowers the score. All word lists live in src/shared/config/questionWords.json so a language
 * can be added without touching this file.
 */
import { z } from 'zod'
import rawQuestionWords from '@shared/config/questionWords.json'

export interface QuestionDetection {
  /** confidence ≥ QUESTION_THRESHOLD. */
  isQuestion: boolean
  /** 0..1, rounded to two decimals. */
  confidence: number
  /** Short machine-readable rule name for logs and tests, e.g. "question-mark", "interrogative:how". */
  reason: string
}

export interface DetectQuestionOptions {
  /**
   * ISO-639-1 code ("en", "bn") or "auto". Languages whose script appears in the text are
   * always considered as well, so code-switched lines work whatever the setting says.
   */
  language?: string
}

export const QUESTION_THRESHOLD = 0.5

// ───────────────────────────── configuration ─────────────────────────────

const wordList = z.array(z.string().trim().min(1))

const languageWordsSchema = z.object({
  /** Unicode script name (as in \p{Script=…}) used to pick the language automatically. */
  script: z.string().min(1).optional(),
  /** True when interrogatives can appear anywhere in the clause (SOV languages such as Bangla). */
  interrogativesAnywhere: z.boolean().optional(),
  interrogatives: wordList,
  auxiliaries: wordList,
  phrases: wordList,
  fillers: wordList,
  tagQuestions: wordList,
  exclamationStarters: wordList,
  weakPhrases: wordList.optional(),
  weakTagQuestions: wordList.optional(),
  personalSubjects: wordList.optional(),
  determiners: wordList.optional(),
  subjects: wordList.optional(),
  imperativeAuxiliaries: wordList.optional(),
  imperativeAuxiliarySubjects: wordList.optional(),
  /** Interrogatives that also introduce relative clauses (", which is fine"). */
  relativeInterrogatives: wordList.optional(),
  statementStarters: wordList.optional(),
  topicShifters: wordList.optional(),
  finalParticles: wordList.optional(),
  embeddedMarkers: wordList.optional(),
})

/** Shape of one language entry in questionWords.json. */
export type QuestionLanguageWords = z.infer<typeof languageWordsSchema>

type Phrase = readonly string[]

interface CompiledLanguage {
  code: string
  script: RegExp | null
  anywhere: boolean
  interrogatives: Set<string>
  auxiliaries: Set<string>
  imperativeAux: Set<string>
  imperativeSubjects: Set<string>
  personal: Set<string>
  determiners: Set<string>
  subjects: Set<string>
  relatives: Set<string>
  finalParticles: Set<string>
  /** Single-word fillers ("so", "and") double as clause boundaries mid-sentence. */
  boundary: Set<string>
  phrases: Phrase[]
  weakPhrases: Phrase[]
  fillers: Phrase[]
  tags: Phrase[]
  weakTags: Phrase[]
  exclamations: Phrase[]
  statements: Phrase[]
  topicShifters: Phrase[]
  embedded: Phrase[]
}

function normWord(word: string): string {
  return word
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\u2018\u2019\u02BC]/g, "'")
}

/** Speech-to-text output often drops apostrophes ("whats", "dont"); accept both spellings. */
function wordSet(list: readonly string[] | undefined): Set<string> {
  const out = new Set<string>()
  for (const entry of list ?? []) {
    const w = normWord(entry)
    out.add(w)
    if (w.includes("'")) out.add(w.replace(/'/g, ''))
  }
  return out
}

/** Longest phrases first so "what about" wins over "what". */
function phraseList(list: readonly string[] | undefined): Phrase[] {
  return (list ?? [])
    .map((entry) => normWord(entry).split(/\s+/).filter(Boolean))
    .filter((p) => p.length > 0)
    .sort((a, b) => b.length - a.length)
}

function compileLanguage(code: string, w: QuestionLanguageWords): CompiledLanguage {
  const fillers = phraseList(w.fillers)
  return {
    code,
    script: w.script ? new RegExp(`\\p{Script=${w.script}}`, 'u') : null,
    anywhere: w.interrogativesAnywhere ?? false,
    interrogatives: wordSet(w.interrogatives),
    auxiliaries: wordSet(w.auxiliaries),
    imperativeAux: wordSet(w.imperativeAuxiliaries),
    imperativeSubjects: wordSet(w.imperativeAuxiliarySubjects),
    personal: wordSet(w.personalSubjects),
    determiners: wordSet(w.determiners),
    subjects: wordSet(w.subjects),
    relatives: wordSet(w.relativeInterrogatives),
    finalParticles: wordSet(w.finalParticles),
    boundary: new Set(fillers.filter((p) => p.length === 1).map((p) => p[0] as string)),
    phrases: phraseList(w.phrases),
    weakPhrases: phraseList(w.weakPhrases),
    fillers,
    tags: phraseList(w.tagQuestions),
    weakTags: phraseList(w.weakTagQuestions),
    exclamations: phraseList(w.exclamationStarters),
    statements: phraseList(w.statementStarters),
    topicShifters: phraseList(w.topicShifters),
    embedded: phraseList(w.embeddedMarkers),
  }
}

function loadLanguages(raw: unknown): Map<string, CompiledLanguage> {
  const entries = Object.entries(raw as Record<string, unknown>).filter(
    ([key]) => !key.startsWith('$'),
  )
  const out = new Map<string, CompiledLanguage>()
  for (const [code, value] of entries) {
    out.set(
      code.toLowerCase(),
      compileLanguage(code.toLowerCase(), languageWordsSchema.parse(value)),
    )
  }
  return out
}

const LANGUAGES = loadLanguages(rawQuestionWords)

/** Language codes the detector has word lists for. */
export const QUESTION_LANGUAGES: readonly string[] = [...LANGUAGES.keys()]

// ───────────────────────────── text handling ─────────────────────────────

interface Token {
  raw: string
  low: string
  start: number
  end: number
}

interface Sentence {
  body: string
  /** Terminator run ("?", ".", "!", "।", "…"), '' when the line just stops. */
  end: string
  tokens: Token[]
  /** Token indexes preceded by a comma, semicolon, colon or dash. */
  breaks: Set<number>
}

interface Score {
  confidence: number
  reason: string
}

const TOKEN_RE = /[\p{L}\p{M}\p{N}\u200C\u200D]+(?:'[\p{L}\p{M}\p{N}\u200C\u200D]+)*/gu
const TERMINATORS = new Set(['.', '!', '?', '।', '॥', '؟', '？', '！', '。', '…'])
const QUESTION_MARK_RE = /[?؟？]/
const EXCLAMATION_RE = /[!！]/
const DANDA_RE = /[।॥]/
const ELLIPSIS_RE = /…|\.\./
const CLAUSE_BREAK_RE = /[,;:\u2014\u2013()]|\s-\s|--/
/** "Mr. Smith", "e.g. this": a period after these never ends a sentence. */
const ABBREVIATIONS = new Set([
  'mr',
  'mrs',
  'ms',
  'dr',
  'prof',
  'sr',
  'jr',
  'st',
  'mt',
  'vs',
  'e.g',
  'i.e',
])

const NO_CUE: Score = { confidence: 0.05, reason: 'no-question-cue' }

function normalizeInput(text: string): string {
  return (
    text
      .normalize('NFC')
      .replace(/[\u2018\u2019\u02BC`\u00B4]/g, "'")
      .replace(/["\u201C\u201D\u201E\u00AB\u00BB\u2039\u203A\u300C\u300D\u300E\u300F]/g, ' ')
      // Apostrophes used as quote marks (not inside a word) carry no meaning here.
      .replace(/(?<![\p{L}\p{M}\p{N}])'|'(?![\p{L}\p{M}\p{N}])/gu, '')
      .replace(/\s+/g, ' ')
      .trim()
  )
}

function isAbbreviation(body: string): boolean {
  const last = /([\p{L}.]+)$/u.exec(body)?.[1]?.toLowerCase()
  if (!last) return false
  // Single-letter initials ("J. Smith"), except "I" which ends sentences ("Neither did I.").
  if (/^\p{L}$/u.test(last)) return last !== 'i'
  return ABBREVIATIONS.has(last)
}

function splitSentences(text: string): { body: string; end: string }[] {
  const out: { body: string; end: string }[] = []
  let start = 0
  let i = 0
  while (i < text.length) {
    if (!TERMINATORS.has(text[i] as string)) {
      i++
      continue
    }
    let j = i
    while (j < text.length && TERMINATORS.has(text[j] as string)) j++
    const run = text.slice(i, j)
    // Only split before whitespace or the end, so "3.5" and "v1.2" stay intact.
    const atBoundary = j >= text.length || /[\s)\]}]/.test(text[j] as string)
    const body = text.slice(start, i).trim()
    if (atBoundary && !(run === '.' && isAbbreviation(body))) {
      if (body) out.push({ body, end: run })
      else if (out.length > 0) (out[out.length - 1] as { end: string }).end += run
      start = j
    }
    i = j
  }
  const tail = text.slice(start).trim()
  if (tail) out.push({ body: tail, end: '' })
  return out
}

function prepareSentence(s: { body: string; end: string }): Sentence {
  const tokens: Token[] = []
  for (const m of s.body.matchAll(TOKEN_RE)) {
    const start = m.index ?? 0
    tokens.push({ raw: m[0], low: normWord(m[0]), start, end: start + m[0].length })
  }
  const breaks = new Set<number>()
  for (let k = 1; k < tokens.length; k++) {
    const gap = s.body.slice((tokens[k - 1] as Token).end, (tokens[k] as Token).start)
    if (CLAUSE_BREAK_RE.test(gap)) breaks.add(k)
  }
  return { body: s.body, end: s.end, tokens, breaks }
}

function tokEq(input: string, cfg: string): boolean {
  return input === cfg || (cfg.includes("'") && input === cfg.replace(/'/g, ''))
}

/** The longest phrase that matches the tokens starting at `i`. */
function matchAt(tokens: readonly Token[], i: number, phrases: readonly Phrase[]): Phrase | null {
  for (const p of phrases) {
    if (i + p.length > tokens.length) continue
    let ok = true
    for (let k = 0; k < p.length; k++) {
      if (!tokEq((tokens[i + k] as Token).low, p[k] as string)) {
        ok = false
        break
      }
    }
    if (ok) return p
  }
  return null
}

function phraseEquals(tokens: readonly Token[], phrase: Phrase): boolean {
  return tokens.length === phrase.length && matchAt(tokens, 0, [phrase]) !== null
}

function endsWith(tokens: readonly Token[], phrase: Phrase): boolean {
  return matchAt(tokens, tokens.length - phrase.length, [phrase]) !== null
}

function best(a: Score, b: Score | null): Score {
  return b && b.confidence > a.confidence ? b : a
}

// ───────────────────────────── scoring ─────────────────────────────

/** Where a starter sits: sentence start, start after fillers with no pause, or a later clause. */
type StarterMode = 'initial' | 'loose' | 'clause'

function skipFillers(
  s: Sentence,
  from: number,
  L: CompiledLanguage,
): { index: number; pauseless: boolean } {
  let j = from
  for (;;) {
    const f = matchAt(s.tokens, j, L.fillers)
    if (!f) break
    j += f.length
  }
  return { index: j, pauseless: j > from && !s.breaks.has(j) }
}

function isCapitalizedName(t: Token, L: CompiledLanguage): boolean {
  return /^\p{Lu}/u.test(t.raw) && !L.auxiliaries.has(t.low) && !L.interrogatives.has(t.low)
}

/** Could `t` be the subject right after an inverted auxiliary ("is IT", "did YOUR team")? */
function isSubject(t: Token, L: CompiledLanguage, strict: boolean): boolean {
  if (L.personal.has(t.low)) return true
  if (strict) return false
  return L.determiners.has(t.low) || L.subjects.has(t.low) || isCapitalizedName(t, L)
}

function interrogativeOf(
  low: string,
  L: CompiledLanguage,
): { base: string; contracted: boolean } | null {
  if (L.interrogatives.has(low)) return { base: low, contracted: false }
  // "what's", "who'd", "how're" and their apostrophe-less STT spellings ("whats").
  const m = /^(\p{L}+)(?:'(?:s|re|d|ll|ve)|s|re|d)$/u.exec(low)
  if (m && L.interrogatives.has(m[1] as string)) return { base: m[1] as string, contracted: true }
  return null
}

function scoreInterrogative(
  toks: readonly Token[],
  i: number,
  wh: { base: string; contracted: boolean },
  L: CompiledLanguage,
  mode: StarterMode,
): Score | null {
  const reason = `interrogative:${wh.base}`
  if (mode === 'clause') {
    // Later clauses need full inversion (", where is the office"). Words that also start
    // relative clauses (", which is the best", ", who's our CTO") need a pronoun subject.
    const relative = L.relatives.has(wh.base)
    if (wh.contracted) return relative ? null : { confidence: 0.75, reason }
    const aux = toks[i + 1]
    const subject = toks[i + 2]
    if (!aux || !subject || !L.auxiliaries.has(aux.low)) return null
    return isSubject(subject, L, relative) ? { confidence: 0.75, reason } : null
  }
  if (wh.contracted) return { confidence: 0.85, reason }
  const next = toks[i + 1]
  if (!next) return { confidence: 0.6, reason }
  if (L.auxiliaries.has(next.low)) return { confidence: 0.85, reason }
  // No inversion: "What we need is…", "When the call ends, …" are statements.
  if (L.personal.has(next.low) || L.determiners.has(next.low)) {
    return { confidence: 0.35, reason: `subordinate:${wh.base}` }
  }
  // "What time is it", "How many people are…", "Which tools do you…"
  for (let k = i + 2; k <= i + 4 && k < toks.length; k++) {
    if (L.auxiliaries.has((toks[k] as Token).low)) return { confidence: 0.8, reason }
  }
  return { confidence: 0.6, reason }
}

function scoreAuxiliary(
  toks: readonly Token[],
  i: number,
  L: CompiledLanguage,
  mode: StarterMode,
): Score | null {
  const aux = (toks[i] as Token).low
  const next = toks[i + 1]
  // Base forms double as imperatives ("Do it now", "Have a seat"): need a plural/2nd-person subject.
  const hasSubject =
    !!next &&
    (L.imperativeAux.has(aux)
      ? L.imperativeSubjects.has(next.low)
      : isSubject(next, L, mode !== 'initial'))
  if (!hasSubject) {
    return mode === 'clause'
      ? null
      : { confidence: 0.3, reason: `auxiliary-without-subject:${aux}` }
  }
  // "So do I", "Is it." — nothing after the subject is too thin to call.
  if (i + 2 >= toks.length) {
    return mode === 'clause' ? null : { confidence: 0.45, reason: `auxiliary-bare:${aux}` }
  }
  return { confidence: mode === 'clause' ? 0.7 : 0.85, reason: `auxiliary:${aux}` }
}

function scoreStarter(
  toks: readonly Token[],
  i: number,
  L: CompiledLanguage,
  mode: StarterMode,
): Score | null {
  const phrase = matchAt(toks, i, L.phrases)
  if (phrase) {
    return { confidence: mode === 'clause' ? 0.7 : 0.8, reason: `phrase:${phrase.join(' ')}` }
  }
  if (mode !== 'clause') {
    const weak = matchAt(toks, i, L.weakPhrases)
    if (weak) return { confidence: 0.35, reason: `weak-phrase:${weak.join(' ')}` }
  }
  const tok = toks[i] as Token
  const wh = interrogativeOf(tok.low, L)
  if (wh) return scoreInterrogative(toks, i, wh, L, mode)
  if (L.auxiliaries.has(tok.low)) return scoreAuxiliary(toks, i, L, mode)
  return null
}

function isNegatedAuxTag(tokens: readonly Token[], L: CompiledLanguage): boolean {
  if (tokens.length !== 2) return false
  const [aux, subject] = tokens as [Token, Token]
  return L.auxiliaries.has(aux.low) && /n'?t$/.test(aux.low) && L.personal.has(subject.low)
}

/** "…, right", "…, isn't it", "It's nice isn't it", Bangla "…, তাই না". */
function scoreTag(s: Sentence, s0: number, L: CompiledLanguage): Score | null {
  const toks = s.tokens
  const n = toks.length
  let lastBreak = -1
  for (const b of s.breaks) lastBreak = Math.max(lastBreak, b)
  if (lastBreak > s0 && lastBreak - s0 >= 2) {
    const clause = toks.slice(lastBreak)
    const strong = L.tags.find((t) => phraseEquals(clause, t))
    if (strong || isNegatedAuxTag(clause, L)) {
      return { confidence: 0.75, reason: `tag:${clause.map((t) => t.low).join(' ')}` }
    }
    const weak = L.weakTags.find((t) => phraseEquals(clause, t))
    // "We agreed, yeah" is as often a statement as a question; only "?" settles it.
    if (weak) return { confidence: 0.45, reason: `weak-tag:${weak.join(' ')}` }
  }
  // Unpunctuated tags. Single-word English tags need the comma ("That's right" is a statement);
  // Bangla particles attach without one ("আপনি রাজি আছেন তো").
  const minBefore = L.anywhere ? 1 : 2
  for (const t of L.tags) {
    if (t.length < 2 && !L.anywhere) continue
    if (n - t.length - s0 >= minBefore && endsWith(toks, t)) {
      return { confidence: t.length < 2 ? 0.6 : 0.65, reason: `tag:${t.join(' ')}` }
    }
  }
  if (!L.anywhere && n - s0 >= 4 && isNegatedAuxTag(toks.slice(n - 2), L)) {
    return { confidence: 0.65, reason: `tag:${toks[n - 2]?.low} ${toks[n - 1]?.low}` }
  }
  return null
}

/** Languages with free question-word placement (Bangla): look at every word of the sentence. */
function scoreAnywhere(s: Sentence, s0: number, L: CompiledLanguage): Score | null {
  const toks = s.tokens
  const n = toks.length
  const masked = new Array<boolean>(n).fill(false)
  let exclamation: Phrase | null = null
  for (let i = 0; i < n; i++) {
    const excl = matchAt(toks, i, L.exclamations)
    const stmt = excl ? null : matchAt(toks, i, L.statements)
    const hit = excl ?? stmt
    if (!hit) continue
    if (excl && !exclamation) exclamation = excl
    for (let k = i; k < i + hit.length; k++) masked[k] = true
  }
  let embedded: Phrase | null = null
  let phrase: Phrase | null = null
  let wh = -1
  for (let i = s0; i < n; i++) {
    embedded ??= matchAt(toks, i, L.embedded)
    phrase ??= matchAt(toks, i, L.phrases)
    if (wh < 0 && !masked[i] && L.interrogatives.has((toks[i] as Token).low)) wh = i
  }
  const last = toks[n - 1]
  const particle = !!last && n - s0 >= 2 && !masked[n - 1] && L.finalParticles.has(last.low)
  if (embedded && (wh >= 0 || phrase || particle)) {
    // "আমি জানি না সে কোথায় গেছে" (I don't know where he went) is a statement.
    return { confidence: 0.3, reason: `embedded:${embedded.join(' ')}` }
  }
  if (phrase) return { confidence: 0.75, reason: `phrase:${phrase.join(' ')}` }
  if (wh >= 0) {
    const edge = wh === s0 || wh === n - 1
    return {
      confidence: edge ? 0.8 : 0.75,
      reason: `interrogative:${(toks[wh] as Token).low}`,
    }
  }
  if (particle) return { confidence: 0.6, reason: `final-particle:${last.low}` }
  if (exclamation) return { confidence: 0.1, reason: `exclamation:${exclamation.join(' ')}` }
  return null
}

function scoreSentence(s: Sentence, L: CompiledLanguage): Score {
  const toks = s.tokens
  const lead = skipFillers(s, 0, L)
  const s0 = lead.index
  if (s0 >= toks.length) return { confidence: 0.05, reason: 'filler-only' }

  let result = NO_CUE
  const excl = matchAt(toks, s0, L.exclamations)
  const stmt = excl ? null : matchAt(toks, s0, L.statements)
  if (excl) result = best(result, { confidence: 0.1, reason: `exclamation:${excl.join(' ')}` })
  else if (stmt) result = best(result, { confidence: 0.15, reason: `statement:${stmt.join(' ')}` })

  if (L.anywhere) {
    result = best(result, scoreAnywhere(s, s0, L))
  } else {
    if (!excl && !stmt) {
      // "So is it ready" keeps full rules but "Now is the time" must not read as inversion.
      result = best(result, scoreStarter(toks, s0, L, lead.pauseless ? 'loose' : 'initial'))
    }
    // Later clauses: "Given the budget, how would you…", "We tried caching so how would you…".
    for (let k = s0 + 1; k < toks.length; k++) {
      if (!s.breaks.has(k) && !L.boundary.has((toks[k - 1] as Token).low)) continue
      const j = skipFillers(s, k, L).index
      if (j < toks.length && j > s0) result = best(result, scoreStarter(toks, j, L, 'clause'))
    }
  }
  result = best(result, scoreTag(s, s0, L))
  return applyPunctuation(result, s.end)
}

/** Statement punctuation counts against a question reading; "?" never reaches here. */
function applyPunctuation(score: Score, end: string): Score {
  if (!end || score.confidence <= NO_CUE.confidence) return score
  if (EXCLAMATION_RE.test(end)) {
    return score.confidence > 0.3
      ? { confidence: 0.3, reason: `${score.reason}+exclamation-mark` }
      : score
  }
  if (DANDA_RE.test(end)) {
    return score.confidence > 0.2 ? { confidence: 0.2, reason: `${score.reason}+danda` } : score
  }
  if (ELLIPSIS_RE.test(end)) return score
  return {
    confidence: Math.max(NO_CUE.confidence, score.confidence - 0.15),
    reason: `${score.reason}+period`,
  }
}

function languagesFor(text: string, language: string | undefined): CompiledLanguage[] {
  const out: CompiledLanguage[] = []
  const code = language?.toLowerCase().split(/[-_]/)[0]
  const preferred = code ? LANGUAGES.get(code) : undefined
  if (preferred) out.push(preferred)
  for (const L of LANGUAGES.values()) {
    if (L !== preferred && L.script?.test(text)) out.push(L)
  }
  return out
}

function isFillerOnly(s: Sentence, langs: readonly CompiledLanguage[]): boolean {
  if (s.tokens.length === 0) return true
  return langs.some((L) => skipFillers(s, 0, L).index >= s.tokens.length)
}

/** A trailing "Right." after a statement acts as a tag: "We ship Friday. Right". */
function trailingTag(s: Sentence, langs: readonly CompiledLanguage[]): Score | null {
  for (const L of langs) {
    const tag = L.tags.find((t) => phraseEquals(s.tokens, t))
    if (tag) return applyPunctuation({ confidence: 0.6, reason: `tag:${tag.join(' ')}` }, s.end)
  }
  return null
}

function startsWithTopicShift(s: Sentence, langs: readonly CompiledLanguage[]): boolean {
  return langs.some((L) => matchAt(s.tokens, 0, L.topicShifters) !== null)
}

/**
 * "What's your experience with React? We use it heavily here." still awaits an answer;
 * "Did you see the game? Anyway, let's get started." does not.
 */
function earlierQuestion(
  sentences: readonly Sentence[],
  lastIdx: number,
  langs: readonly CompiledLanguage[],
): Score | null {
  for (let j = lastIdx - 1; j >= 0; j--) {
    if (!QUESTION_MARK_RE.test((sentences[j] as Sentence).end)) continue
    const after = sentences.slice(j + 1, lastIdx + 1)
    return after.some((s) => startsWithTopicShift(s, langs))
      ? { confidence: 0.3, reason: 'question-then-topic-shift' }
      : { confidence: 0.6, reason: 'earlier-question' }
  }
  return null
}

function finish(confidence: number, reason: string): QuestionDetection {
  const c = Math.round(Math.min(1, Math.max(0, confidence)) * 100) / 100
  return { isQuestion: c >= QUESTION_THRESHOLD, confidence: c, reason }
}

/**
 * Decides whether a transcript line is a question addressed to the listener.
 * isQuestion ⇔ confidence ≥ 0.5.
 */
export function detectQuestion(text: string, opts: DetectQuestionOptions = {}): QuestionDetection {
  const clean = normalizeInput(typeof text === 'string' ? text : '')
  if (!/[\p{L}\p{N}]/u.test(clean)) return finish(0, 'empty')
  const sentences = splitSentences(clean).map(prepareSentence)
  if (sentences.length === 0) return finish(0, 'empty')
  const langs = languagesFor(clean, opts.language)

  // Trailing fillers ("…approach it? Um.") must not hide the question before them.
  let lastIdx = sentences.length - 1
  let tag: Score | null = null
  while (lastIdx > 0 && isFillerOnly(sentences[lastIdx] as Sentence, langs)) {
    const trailing = sentences[lastIdx] as Sentence
    if (QUESTION_MARK_RE.test(trailing.end)) return finish(0.95, 'question-mark')
    tag ??= trailingTag(trailing, langs)
    lastIdx--
  }
  const last = sentences[lastIdx] as Sentence
  if (QUESTION_MARK_RE.test(last.end)) return finish(0.95, 'question-mark')
  if (last.body.startsWith('¿')) return finish(0.9, 'inverted-question-mark')

  // Seed with the first language's score (not NO_CUE) so low-score reasons such as
  // "exclamation:how nice" survive for logs.
  let result: Score = NO_CUE
  langs.forEach((L, k) => {
    const score = scoreSentence(last, L)
    result = k === 0 ? score : best(result, score)
  })
  result = best(result, tag)
  if (result.confidence < QUESTION_THRESHOLD) {
    result = best(result, earlierQuestion(sentences, lastIdx, langs))
  }
  return finish(result.confidence, result.reason)
}
