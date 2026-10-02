import type { Settings } from '@shared/settings'
import type { KnowledgeSnippet, LiveRequestKind, Mode, TranscriptLine } from '@shared/types'
import type { ChatContentPart, ChatMessage } from '../providers/llm/LLMProvider'
import {
  PROMPT_SPEAKER,
  formatDateTime,
  formatTimestamp,
  mergeTranscriptLines,
  usableLines,
} from './format'
import {
  actionInstruction,
  answerLanguageRule,
  basePrompt,
  modeSection,
  profileSection,
  toneGuide,
  type PromptKind,
} from './prompts'
import { estimateMessagesTokens } from './tokens'

export { formatTimestamp } from './format'

/** Default verbatim transcript window for live requests. */
export const DEFAULT_CONTEXT_MINUTES = 6
/** Default prompt budget for live requests (speed matters more than completeness). */
export const DEFAULT_MAX_PROMPT_TOKENS = 6000
/** Budget truncation never drops transcript lines that started within this window. */
export const KEEP_RECENT_MS = 90_000
/** Fact check focuses on claims from this far back. */
export const FACTCHECK_WINDOW_MS = 60_000
/** Snippet count kept when the budget forces trimming. */
export const TRIMMED_SNIPPET_COUNT = 4
/** retrievalQueryFrom() output cap. */
export const RETRIEVAL_QUERY_MAX_CHARS = 300

/** A summary shorter than this after clipping is dropped instead (it would be noise). */
const MIN_SUMMARY_CHARS = 80
/** Meeting notes shorter than this after clipping are dropped instead. */
const MIN_NOTES_CHARS = 200

const LIVE_KINDS: ReadonlySet<PromptKind> = new Set<LiveRequestKind>([
  'assist',
  'say',
  'followups',
  'factcheck',
  'who',
  'recap',
  'ask',
  'auto',
])

/**
 * Review-time kinds read a whole finished meeting (or several), so they default to the full
 * transcript and a larger budget than the latency-critical live actions.
 */
const KIND_DEFAULT_MAX_TOKENS: Partial<Record<PromptKind, number>> = {
  meeting_chat: 24_000,
  search_ask: 12_000,
}

export interface MeetingExcerpt {
  title: string
  /** Epoch ms. */
  startedAt: number
  text: string
}

export interface ContextInput {
  kind: PromptKind
  mode: Mode
  profile: Settings['profile']
  answerLanguage: Settings['language']['answer']
  /** Session lines; only final, non-empty lines are used. */
  transcript: TranscriptLine[]
  /** Milliseconds since the session started ("now" on the transcript clock). */
  nowMs: number
  /**
   * Verbatim window in minutes. Default 6 for live kinds and 'summary'; the whole transcript for
   * 'meeting_chat' / 'search_ask'.
   */
  contextMinutes?: number
  runningSummary?: string | null
  /**
   * RunningSummarizer.coveredUntilMs(). When given, lines that are older than the window but not
   * yet folded into the summary stay verbatim, so nothing falls into the gap between summary runs.
   */
  summaryCoveredUntilMs?: number | null
  knowledge?: KnowledgeSnippet[]
  question?: string | null
  screenshot?: { dataUrl: string } | null
  /** Auto-suggest: the question that triggered it. */
  trigger?: { text: string } | null
  /** meeting_chat: the session's notes (e.g. renderNotesMarkdown output). */
  notesMarkdown?: string | null
  /** search_ask: retrieved excerpts, best first. */
  excerpts?: MeetingExcerpt[]
  /** Default 6000 (24000 for meeting_chat, 12000 for search_ask). */
  maxPromptTokens?: number
}

export interface BuiltContext {
  messages: ChatMessage[]
  promptTokens: number
  usedScreen: boolean
  /** Transcript lines included verbatim. */
  transcriptLines: number
  /** True when the token budget forced anything to be dropped or shortened. */
  truncated: boolean
}

/** The variable parts of the prompt that the budget may shrink. */
interface Draft {
  summary: string | null
  notes: string | null
  lines: TranscriptLine[]
  snippets: KnowledgeSnippet[]
  excerpts: MeetingExcerpt[]
}

function isLiveKind(kind: PromptKind): boolean {
  return LIVE_KINDS.has(kind)
}

function clean(text: string | null | undefined): string {
  return (text ?? '').trim()
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Keeps the end of `text` (the most recent part of a running summary). */
function clipTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  if (maxChars <= 1) return ''
  let tail = text.slice(text.length - (maxChars - 1))
  const space = tail.search(/\s/)
  if (space >= 0 && space < 40) tail = tail.slice(space + 1)
  return `…${tail}`
}

/** Keeps the start of `text` (meeting notes lead with title and summary). */
function clipHead(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  if (maxChars <= 1) return ''
  let head = text.slice(0, maxChars - 1)
  const space = head.search(/\s\S*$/)
  if (space > head.length - 40 && space > 0) head = head.slice(0, space)
  return `${head}…`
}

function systemPrompt(input: ContextInput): string {
  return [
    basePrompt(),
    modeSection(input.mode),
    toneGuide(input.mode.tone),
    profileSection(input.profile),
    answerLanguageRule(input.answerLanguage),
    actionInstruction(input.kind, { modeId: input.mode.id }),
  ]
    .filter((s) => s.length > 0)
    .join('\n\n')
}

function factcheckFocusMs(lines: TranscriptLine[], nowMs: number): number {
  const from = Math.max(0, nowMs - FACTCHECK_WINDOW_MS)
  if (lines.some((l) => l.endMs >= from)) return from
  // Quiet for the last minute: focus on the latest thing that was said instead.
  const last = lines[lines.length - 1]
  return last ? last.startMs : from
}

function lastThemText(lines: TranscriptLine[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (line && line.channel === 'them') return oneLine(line.text)
  }
  return ''
}

function taskLine(input: ContextInput, allLines: TranscriptLine[], usedScreen: boolean): string {
  const question = clean(input.question)
  let line: string
  switch (input.kind) {
    case 'auto': {
      const asked = oneLine(clean(input.trigger?.text)) || lastThemText(allLines)
      line = asked ? `They just asked: "${asked}"` : 'They just asked a question.'
      break
    }
    case 'ask':
    case 'meeting_chat':
    case 'search_ask':
      line = question ? `My question: ${question}` : 'Answer based on the context above.'
      break
    case 'factcheck':
      line = `Focus on claims from [${formatTimestamp(factcheckFocusMs(allLines, input.nowMs))}] onward.`
      break
    case 'assist':
      line = 'Help me with this exact moment.'
      break
    case 'say':
      line = 'What should I say right now?'
      break
    case 'followups':
      line = 'What should I ask next?'
      break
    case 'who':
      line = 'Who am I talking to?'
      break
    case 'recap':
      line = 'Recap the conversation so far.'
      break
    case 'summary':
      line = 'Update the running summary.'
      break
  }
  return usedScreen ? `${line}\nMy current screen is attached.` : line
}

function transcriptSection(draft: Draft, input: ContextInput, totalLines: number): string | null {
  if (draft.lines.length === 0) {
    return isLiveKind(input.kind) ? '## Transcript\n(Nothing transcribed yet.)' : null
  }
  const first = draft.lines[0] as TranscriptLine
  let heading = '## Transcript'
  if (draft.lines.length < totalLines) {
    const minutes = Math.max(1, Math.ceil((input.nowMs - first.startMs) / 60_000))
    heading = `## Transcript (last ${minutes} min)`
  }
  const body = mergeTranscriptLines(draft.lines)
    .map((b) => `[${formatTimestamp(b.startMs)}] ${PROMPT_SPEAKER[b.channel]}: ${b.text}`)
    .join('\n')
  return `${heading}\n${body}`
}

function userText(draft: Draft, input: ContextInput, task: string, totalLines: number): string {
  const sections: string[] = []
  if (draft.summary) sections.push(`## Earlier in the call (summary)\n${draft.summary}`)
  if (draft.notes) sections.push(`## Meeting notes\n${draft.notes}`)
  const transcript = transcriptSection(draft, input, totalLines)
  if (transcript) sections.push(transcript)
  if (draft.snippets.length) {
    const items = draft.snippets.map((s, i) => `[${i + 1}] (${s.filename}) ${oneLine(s.text)}`)
    sections.push(`## Knowledge snippets\n${items.join('\n')}`)
  }
  if (draft.excerpts.length) {
    const items = draft.excerpts.map(
      (e, i) =>
        `[${i + 1}] ${oneLine(e.title) || 'Untitled'} (${formatDateTime(e.startedAt)})\n${e.text.trim()}`,
    )
    sections.push(`## Meeting excerpts\n${items.join('\n\n')}`)
  }
  sections.push(task)
  return sections.join('\n\n')
}

/**
 * Assembles the chat messages for one AI request: system = base + mode + tone + profile +
 * language rule + action instruction; user = summary, transcript window, knowledge snippets
 * (and notes/excerpts for review kinds), then the task line, plus the screenshot when given.
 * Keeps the prompt within `maxPromptTokens` by dropping the oldest transcript lines first
 * (never the last 90 s), then trimming snippets to 4, then shortening the summary.
 */
export function buildContext(input: ContextInput): BuiltContext {
  const live = isLiveKind(input.kind) || input.kind === 'summary'
  const maxTokens =
    input.maxPromptTokens ?? KIND_DEFAULT_MAX_TOKENS[input.kind] ?? DEFAULT_MAX_PROMPT_TOKENS
  const minutes = input.contextMinutes ?? (live ? DEFAULT_CONTEXT_MINUTES : Infinity)

  const allLines = usableLines(input.transcript)
  const windowStart = input.nowMs - minutes * 60_000
  let verbatimStart = windowStart
  if (input.summaryCoveredUntilMs != null) {
    // Without a summary nothing is actually covered, so everything older stays verbatim.
    const covered = clean(input.runningSummary) ? input.summaryCoveredUntilMs : 0
    verbatimStart = Math.min(windowStart, covered)
  }

  const screenUrl = input.screenshot?.dataUrl ?? ''
  // Only inline data URLs: the screenshot is captured locally and must never be a remote fetch.
  const usedScreen = screenUrl.startsWith('data:image/')
  const system = systemPrompt(input)
  const task = taskLine(input, allLines, usedScreen)

  const render = (draft: Draft): ChatMessage[] => {
    const text = userText(draft, input, task, allLines.length)
    const content: string | ChatContentPart[] = usedScreen
      ? [
          { type: 'text', text },
          { type: 'image_url', image_url: { url: screenUrl } },
        ]
      : text
    return [
      { role: 'system', content: system },
      { role: 'user', content },
    ]
  }
  const measure = (draft: Draft) => estimateMessagesTokens(render(draft))

  let draft: Draft = {
    summary: clean(input.runningSummary) || null,
    notes: input.kind === 'meeting_chat' ? clean(input.notesMarkdown) || null : null,
    lines: allLines.filter((l) => l.startMs >= verbatimStart),
    snippets: (input.knowledge ?? []).filter((s) => s.text.trim().length > 0),
    excerpts: input.kind === 'search_ask' ? [...(input.excerpts ?? [])] : [],
  }
  let tokens = measure(draft)
  let truncated = false

  // 1. Oldest transcript lines first; the last 90 s always stay.
  if (tokens > maxTokens) {
    const keepFrom = input.nowMs - KEEP_RECENT_MS
    let droppable = 0
    while (droppable < draft.lines.length && (draft.lines[droppable]?.startMs ?? 0) < keepFrom) {
      droppable++
    }
    if (droppable > 0) {
      const withDropped = (k: number): Draft => ({ ...draft, lines: draft.lines.slice(k) })
      // Token count only shrinks as more lines go, so binary-search the fewest drops that fit.
      let lo = 1
      let hi = droppable
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (measure(withDropped(mid)) <= maxTokens) hi = mid
        else lo = mid + 1
      }
      draft = withDropped(lo)
      tokens = measure(draft)
      truncated = true
    }
  }

  // 2. Snippets down to the top 4.
  if (tokens > maxTokens && draft.snippets.length > TRIMMED_SNIPPET_COUNT) {
    draft = { ...draft, snippets: draft.snippets.slice(0, TRIMMED_SNIPPET_COUNT) }
    tokens = measure(draft)
    truncated = true
  }

  // 3. Shorten the running summary (keeping its most recent part).
  if (tokens > maxTokens && draft.summary) {
    const full = draft.summary
    let lo = 0
    let hi = full.length
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (measure({ ...draft, summary: clipTail(full, mid) || null }) <= maxTokens) lo = mid
      else hi = mid - 1
    }
    const clipped = clipTail(full, lo)
    draft = { ...draft, summary: clipped.length >= MIN_SUMMARY_CHARS ? clipped : null }
    tokens = measure(draft)
    truncated = true
  }

  // 4. Review kinds: fewer excerpts (lowest-ranked first), then shorter notes.
  while (tokens > maxTokens && draft.excerpts.length > 1) {
    draft = { ...draft, excerpts: draft.excerpts.slice(0, -1) }
    tokens = measure(draft)
    truncated = true
  }
  if (tokens > maxTokens && draft.notes) {
    const full = draft.notes
    let lo = 0
    let hi = full.length
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (measure({ ...draft, notes: clipHead(full, mid) || null }) <= maxTokens) lo = mid
      else hi = mid - 1
    }
    const clipped = clipHead(full, lo)
    draft = { ...draft, notes: clipped.length >= MIN_NOTES_CHARS ? clipped : null }
    tokens = measure(draft)
    truncated = true
  }

  return {
    messages: render(draft),
    promptTokens: tokens,
    usedScreen,
    transcriptLines: draft.lines.length,
    truncated,
  }
}

/**
 * FTS query for knowledge retrieval: the last 1–2 Them lines (≤ 300 chars, keeping the most
 * recent words), falling back to the last line from either channel.
 */
export function retrievalQueryFrom(transcript: TranscriptLine[]): string {
  const lines = usableLines(transcript)
  const them = lines.filter((l) => l.channel === 'them')
  const picked = them.length ? them.slice(-2) : lines.slice(-1)
  const query = oneLine(picked.map((l) => l.text).join(' '))
  if (query.length <= RETRIEVAL_QUERY_MAX_CHARS) return query
  let tail = query.slice(query.length - RETRIEVAL_QUERY_MAX_CHARS)
  // Drop a partial leading word.
  if (!/\s/.test(query[query.length - RETRIEVAL_QUERY_MAX_CHARS - 1] ?? ' ')) {
    const space = tail.indexOf(' ')
    if (space >= 0) tail = tail.slice(space + 1)
  }
  return tail.trim()
}
