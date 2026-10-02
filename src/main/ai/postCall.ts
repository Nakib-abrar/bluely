import { z } from 'zod'
import { t } from '@shared/i18n'
import type { Settings } from '@shared/settings'
import type { FollowUpEmail, MeetingNotes, Mode, SpeedStats } from '@shared/types'
import type { Logger } from '../log'
import { ProviderError } from '../providers/errors'
import type {
  ChatMessage,
  ChatUsage,
  LLMProvider,
  ProviderRouting,
} from '../providers/llm/LLMProvider'
import { answerBudget } from '../providers/llm/reasoning'
import { extractJsonObject, extractJsonValue } from './json'
import { POST_CALL_MESSAGES } from './labels'
import {
  postActionsPrompt,
  postChunkPrompt,
  postEmailPrompt,
  postLanguageRule,
  postModeContext,
  postNotesPrompt,
  postSystemPrompt,
  profileSection,
} from './prompts'
import { estimateTokens, messagesToText } from './tokens'

export type PostCallPart = 'notes' | 'actions' | 'email'

export interface PostCallActionItem {
  text: string
  owner: string | null
  due: string | null
}

/** One model call's numbers, for ai_messages rows and spend tracking. */
export interface PostCallCallStats {
  stats: SpeedStats
  usage: ChatUsage | null
  promptText: string
  responseText: string
}

export interface PostCallPartStats extends PostCallCallStats {
  part: PostCallPart
}

export interface PostCallResult {
  notes: MeetingNotes | null
  actionItems: PostCallActionItem[] | null
  email: FollowUpEmail | null
  /**
   * One entry per requested part that failed; the other parts are still usable. A part that was
   * not requested (see PostCallInput.parts) is null without an error.
   */
  errors: { part: PostCallPart; message: string }[]
  /** One entry per part whose model call completed (even if its JSON was unusable). */
  stats: PostCallPartStats[]
  /** Set when the transcript was too long and was first condensed chunk by chunk. */
  mapReduce: { chunks: number; stats: PostCallCallStats[] } | null
}

export interface PostCallInput {
  model: string
  routing?: ProviderRouting
  /** Transcript as `[mm:ss] Me: …` lines (see formatTranscript). */
  transcriptText: string
  mode: Mode
  profile: Settings['profile']
  answerLanguage: Settings['language']['answer']
  signal?: AbortSignal
  /** Above this estimate the transcript is condensed in chunks first. Default 60000. */
  maxTranscriptTokens?: number
  /** Which parts to generate (default: all three). Used to regenerate only what is missing. */
  parts?: readonly PostCallPart[]
}

export interface PostCallDeps {
  llm: LLMProvider
  log?: Logger
}

export const DEFAULT_MAX_TRANSCRIPT_TOKENS = 60_000
export const POST_CALL_PARTS: readonly PostCallPart[] = ['notes', 'actions', 'email']
/**
 * Output caps (max_tokens). Without one OpenRouter reserves the model's whole output length
 * (64k tokens for Claude Sonnet 4.5) per request, so low-credit accounts get 402 on all three
 * parts and a runaway answer is billed in full. The prompts' word limits fit easily, in Bangla
 * too (which costs several times more tokens per word than English).
 */
export const PART_MAX_TOKENS: Readonly<Record<PostCallPart, number>> = {
  notes: 3_000,
  actions: 2_000,
  email: 2_000,
}
/** Output cap for one map-reduce chunk summary (≤ 350 words). */
export const CHUNK_MAX_TOKENS = 3_000
const CHUNK_CONCURRENCY = 3
/** Condense rounds before giving up on shrinking further (one round is plenty in practice). */
const MAX_REDUCE_ROUNDS = 3
const MAX_TITLE_WORDS = 12

// ───────────────────────────── coercion ─────────────────────────────

const NULLISH_VALUES = new Set([
  '',
  'null',
  'none',
  'nil',
  'n/a',
  'na',
  'unknown',
  'not mentioned',
  'not specified',
  'unspecified',
  'unassigned',
  'tbd',
  '-',
  '—',
])

const TEXT_KEYS = ['text', 'point', 'title', 'description', 'item', 'decision', 'task', 'content']

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function normKey(key: string): string {
  return key.toLowerCase().replace(/[\s_-]/g, '')
}

/** First present value among `keys`, matching case/underscore-insensitively as a fallback. */
function pick(obj: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const k of keys) if (obj[k] !== undefined) return obj[k]
  const wanted = new Set(keys.map(normKey))
  for (const [k, v] of Object.entries(obj)) if (wanted.has(normKey(k)) && v !== undefined) return v
  return undefined
}

/** `{"notes": {...}}` → `{...}`: some models wrap the requested object in one more key. */
function unwrap(
  obj: Record<string, unknown>,
  expected: readonly string[],
): Record<string, unknown> {
  const values = Object.values(obj)
  const only = values.length === 1 ? values[0] : undefined
  return isRecord(only) && pick(only, expected) !== undefined ? only : obj
}

function stripBullet(s: string): string {
  return s.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim()
}

function toText(v: unknown): unknown {
  if (v == null) return ''
  if (typeof v === 'string') return v.trim()
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return v
}

function itemText(v: unknown): string {
  if (typeof v === 'string') return stripBullet(v)
  if (typeof v === 'number') return String(v)
  if (isRecord(v)) {
    const found = pick(v, TEXT_KEYS)
    if (typeof found === 'string') return stripBullet(found)
  }
  return ''
}

/** string → [string] (or one item per bullet line), null → [], drops empty items. */
function toTextList(v: unknown): unknown {
  if (v == null) return []
  if (typeof v === 'string') {
    const lines = v.split(/\r?\n/).filter((l) => l.trim())
    const bulleted = lines.length > 1 && lines.every((l) => /^\s*(?:[-*•]|\d+[.)])\s+/.test(l))
    return (bulleted ? lines : [v]).map(itemText).filter((s) => s.length > 0)
  }
  if (Array.isArray(v)) return v.map(itemText).filter((s) => s.length > 0)
  return v
}

/** '' / "none" / "unknown" → null: owner and due are only kept when actually mentioned. */
function toNullableText(v: unknown): unknown {
  if (v == null) return null
  if (typeof v === 'number') return String(v)
  if (typeof v !== 'string') return null
  const s = v.trim()
  return NULLISH_VALUES.has(s.toLowerCase()) ? null : s
}

const zText = z.preprocess(toText, z.string())
const zTextList = z.preprocess(toTextList, z.array(z.string()))
const zNullableText = z.preprocess(toNullableText, z.string().nullable())

const NOTES_KEYS = {
  title: ['title', 'meetingTitle', 'name', 'subject'],
  summary: ['summary', 'overview', 'abstract'],
  keyPoints: ['keyPoints', 'points', 'highlights', 'keyTakeaways', 'takeaways'],
  decisions: ['decisions', 'decisionsMade', 'agreements'],
} as const

const notesSchema = z.preprocess(
  (raw) => {
    if (!isRecord(raw)) return raw
    const obj = unwrap(raw, [...NOTES_KEYS.summary, ...NOTES_KEYS.keyPoints])
    return {
      title: pick(obj, NOTES_KEYS.title),
      summary: pick(obj, NOTES_KEYS.summary),
      keyPoints: pick(obj, NOTES_KEYS.keyPoints),
      decisions: pick(obj, NOTES_KEYS.decisions),
    }
  },
  z.object({ title: zText, summary: zText, keyPoints: zTextList, decisions: zTextList }),
)

const ACTION_TEXT_KEYS = ['text', 'task', 'action', 'item', 'title', 'description'] as const

const actionItemSchema = z.preprocess(
  (raw) => {
    if (typeof raw === 'string') return { text: stripBullet(raw), owner: null, due: null }
    if (!isRecord(raw)) return raw
    return {
      text: pick(raw, ACTION_TEXT_KEYS),
      owner: pick(raw, ['owner', 'assignee', 'assignedTo', 'who', 'responsible']),
      due: pick(raw, ['due', 'dueDate', 'deadline', 'when', 'by']),
    }
  },
  z.object({ text: zText, owner: zNullableText, due: zNullableText }),
)

const ACTION_LIST_KEYS = ['items', 'actionItems', 'actions', 'tasks', 'todos'] as const

const EMAIL_KEYS = {
  subject: ['subject', 'subjectLine', 'title'],
  body: ['body', 'text', 'content', 'message', 'email'],
} as const

const emailSchema = z.preprocess(
  (raw) => {
    if (!isRecord(raw)) return raw
    const obj = unwrap(raw, [...EMAIL_KEYS.subject, ...EMAIL_KEYS.body])
    return { subject: pick(obj, EMAIL_KEYS.subject), body: pick(obj, EMAIL_KEYS.body) }
  },
  z.object({ subject: zText, body: zText }),
)

function cleanTitle(title: string): string {
  const words = title
    .replace(/^["'“‘]+|["'”’]+$/g, '')
    .replace(/[.。]+$/, '')
    .split(/\s+/)
    .filter(Boolean)
  return words.slice(0, MAX_TITLE_WORDS).join(' ')
}

/** Fallback title: the first ≤ 8 words of the summary's first sentence. */
function titleFromSummary(summary: string): string {
  const sentence = summary.split(/(?<=[.!?。])\s/)[0] ?? ''
  return cleanTitle(
    sentence
      .split(/\s+/)
      .slice(0, 8)
      .join(' ')
      .replace(/[,;:]+$/, ''),
  )
}

/** Validates and coerces the notes JSON; null when nothing usable is in it. */
export function parseNotes(raw: unknown): MeetingNotes | null {
  const parsed = notesSchema.safeParse(raw)
  if (!parsed.success) return null
  const { summary, keyPoints, decisions } = parsed.data
  if (!summary && keyPoints.length === 0) return null
  const title = cleanTitle(parsed.data.title) || titleFromSummary(summary)
  return { title, summary, keyPoints, decisions }
}

/**
 * The list of raw action items in a reply, or null when the reply has no recognizable list.
 * Accepts `{"items": [...]}` (and aliases, also wrapped one level deep), a bare `[...]`, a single
 * item object, or an object whose only array is the list.
 */
function actionList(raw: unknown): unknown[] | null {
  if (Array.isArray(raw)) return raw
  if (!isRecord(raw)) return null
  const obj = unwrap(raw, ACTION_LIST_KEYS)
  const list = pick(obj, ACTION_LIST_KEYS)
  if (list !== undefined) {
    if (list == null) return []
    if (typeof list === 'string' && NULLISH_VALUES.has(list.trim().toLowerCase())) return []
    return Array.isArray(list) ? list : [list]
  }
  if (pick(obj, ACTION_TEXT_KEYS) !== undefined) return [obj]
  const arrays = Object.values(obj).filter((v): v is unknown[] => Array.isArray(v))
  return arrays.length === 1 ? (arrays[0] ?? null) : null
}

/**
 * Validates and coerces the action items JSON; [] when the meeting had none. Null (unreadable)
 * when there is no list, or a list none of whose items is usable: an empty success would wipe
 * the session's existing action items.
 */
export function parseActionItems(raw: unknown): PostCallActionItem[] | null {
  const rawItems = actionList(raw)
  if (rawItems === null) return null
  const seen = new Set<string>()
  const items: PostCallActionItem[] = []
  for (const rawItem of rawItems) {
    const parsed = actionItemSchema.safeParse(rawItem)
    if (!parsed.success || !parsed.data.text) continue
    const key = parsed.data.text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    items.push(parsed.data)
  }
  return rawItems.length > 0 && items.length === 0 ? null : items
}

/** Validates and coerces the email JSON; null when there is no body. */
export function parseEmail(raw: unknown): FollowUpEmail | null {
  const parsed = emailSchema.safeParse(raw)
  if (!parsed.success) return null
  let body = parsed.data.body.replace(/\r\n?/g, '\n')
  // Some models double-escape newlines inside JSON strings.
  if (!body.includes('\n') && body.includes('\\n')) body = body.replace(/\\n/g, '\n')
  body = body.trim()
  if (!body) return null
  return { subject: parsed.data.subject.replace(/\s+/g, ' '), body }
}

// ───────────────────────────── requests ─────────────────────────────

function errorMessage(err: unknown): string {
  if (err instanceof ProviderError) return err.message
  return t('errors.unknown')
}

function systemFor(input: PostCallInput, task: string): string {
  return [
    postSystemPrompt(),
    postModeContext(input.mode),
    profileSection(input.profile),
    postLanguageRule(input.answerLanguage),
    task,
  ]
    .filter((s) => s.length > 0)
    .join('\n\n')
}

function partTask(part: PostCallPart, input: PostCallInput): string {
  if (part === 'notes') return postNotesPrompt()
  if (part === 'actions') return postActionsPrompt()
  return postEmailPrompt(input.mode.tone, input.profile.name)
}

function partMessages(
  part: PostCallPart,
  input: PostCallInput,
  body: string,
  condensed: boolean,
): ChatMessage[] {
  const heading = condensed
    ? '## Transcript, condensed part by part (the full transcript was too long)'
    : '## Transcript'
  return [
    { role: 'system', content: systemFor(input, partTask(part, input)) },
    { role: 'user', content: `${heading}\n${body}\n\nRespond with only the JSON object.` },
  ]
}

type PartOutcome<T> =
  | { ok: true; value: T; stats: PostCallPartStats }
  | { ok: false; message: string; stats: PostCallPartStats | null }

async function runPart<T>(
  deps: PostCallDeps,
  input: PostCallInput,
  part: PostCallPart,
  body: string,
  condensed: boolean,
  parse: (raw: unknown) => T | null,
): Promise<PartOutcome<T>> {
  const messages = partMessages(part, input, body, condensed)
  const promptText = messagesToText(messages)
  // Notes quality benefits from some reasoning, so models that think get medium effort.
  const budget = answerBudget(input.model, PART_MAX_TOKENS[part], 'medium')
  let stats: PostCallPartStats | null = null
  try {
    const res = await deps.llm.complete({
      model: input.model,
      routing: input.routing,
      messages,
      maxTokens: budget.maxTokens,
      ...(budget.reasoning ? { reasoning: budget.reasoning } : {}),
      temperature: 0.2,
      responseFormat: 'json_object',
      signal: input.signal,
      tag: `post_${part}`,
    })
    stats = { part, stats: res.stats, usage: res.usage, promptText, responseText: res.text }
    if (!res.text.trim()) return { ok: false, message: POST_CALL_MESSAGES.emptyResponse, stats }
    // Action items may come back as a bare array; notes and email are always objects.
    const raw = part === 'actions' ? extractJsonValue(res.text) : extractJsonObject(res.text)
    const value = parse(raw)
    if (value === null) {
      deps.log?.warn(`post-call ${part}: unusable JSON`, {
        preview: res.text.slice(0, 200),
        finishReason: res.finishReason,
      })
      const cutOff = res.finishReason === 'length'
      return {
        ok: false,
        message: cutOff ? POST_CALL_MESSAGES.truncatedResponse : POST_CALL_MESSAGES.invalidResponse,
        stats,
      }
    }
    return { ok: true, value, stats }
  } catch (err) {
    deps.log?.warn(`post-call ${part} failed`, err)
    return { ok: false, message: errorMessage(err), stats }
  }
}

// ───────────────────────────── map-reduce ─────────────────────────────

/** Splits on line boundaries into ~equal chunks of at most ~`maxTokens` each. */
export function splitTranscript(text: string, maxTokens: number): string[] {
  const total = estimateTokens(text)
  if (total <= maxTokens) return [text]
  const target = Math.ceil(total / Math.ceil(total / maxTokens))
  const chunks: string[] = []
  let current: string[] = []
  let currentTokens = 0
  const flush = () => {
    if (current.length) chunks.push(current.join('\n'))
    current = []
    currentTokens = 0
  }
  for (const line of text.split('\n')) {
    const lineTokens = estimateTokens(line) + 1
    if (lineTokens > target) {
      // A single enormous line: hard-split it so no chunk overflows.
      flush()
      const charsPerPiece = Math.max(1, Math.floor((line.length * target) / lineTokens))
      for (let i = 0; i < line.length; i += charsPerPiece) {
        chunks.push(line.slice(i, i + charsPerPiece))
      }
      continue
    }
    if (currentTokens + lineTokens > target && current.length) flush()
    current.push(line)
    currentTokens += lineTokens
  }
  flush()
  return chunks
}

/** Runs `fn` over `items` with bounded concurrency; rejects with the first error. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length)
  let next = 0
  let failed = false
  let firstError: unknown = null
  const worker = async () => {
    while (!failed && next < items.length) {
      const index = next++
      try {
        results[index] = await fn(items[index] as T, index)
      } catch (err) {
        if (!failed) firstError = err
        failed = true
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  if (failed) throw firstError
  return results
}

async function condense(
  deps: PostCallDeps,
  input: PostCallInput,
  text: string,
  maxTokens: number,
  stats: PostCallCallStats[],
): Promise<{ text: string; chunks: number }> {
  let current = text
  let chunkCount = 0
  for (let round = 0; round < MAX_REDUCE_ROUNDS && estimateTokens(current) > maxTokens; round++) {
    const chunks = splitTranscript(current, maxTokens)
    chunkCount += chunks.length
    deps.log?.info(`post-call: condensing transcript in ${chunks.length} chunks`, { round })
    const summaries = await mapLimit(chunks, CHUNK_CONCURRENCY, async (chunk, i) => {
      if (input.signal?.aborted) throw new ProviderError('aborted')
      const messages: ChatMessage[] = [
        { role: 'system', content: systemFor(input, postChunkPrompt(i + 1, chunks.length)) },
        {
          role: 'user',
          content: `## Transcript (part ${i + 1} of ${chunks.length})\n${chunk}`,
        },
      ]
      const budget = answerBudget(input.model, CHUNK_MAX_TOKENS, 'medium')
      const res = await deps.llm.complete({
        model: input.model,
        routing: input.routing,
        messages,
        maxTokens: budget.maxTokens,
        ...(budget.reasoning ? { reasoning: budget.reasoning } : {}),
        temperature: 0.2,
        signal: input.signal,
        tag: 'post_chunk',
      })
      stats.push({
        stats: res.stats,
        usage: res.usage,
        promptText: messagesToText(messages),
        responseText: res.text,
      })
      const summary = res.text.trim()
      if (!summary) throw new Error('empty chunk summary')
      return summary
    })
    current = summaries.map((s, i) => `### Part ${i + 1} of ${summaries.length}\n${s}`).join('\n\n')
  }
  return { text: current, chunks: chunkCount }
}

// ───────────────────────────── entry point ─────────────────────────────

function allFailed(
  parts: readonly PostCallPart[],
  message: string,
  base: Partial<PostCallResult> = {},
): PostCallResult {
  return {
    notes: null,
    actionItems: null,
    email: null,
    errors: parts.map((part) => ({ part, message })),
    stats: [],
    mapReduce: null,
    ...base,
  }
}

/**
 * Generates meeting notes, action items and a follow-up email with three parallel JSON requests
 * to the Notes model (or only `input.parts`). Each part succeeds or fails on its own; never
 * throws. Transcripts above `maxTranscriptTokens` are first condensed chunk by chunk (map) and the
 * prompts then run on the joined chunk notes (reduce).
 */
export async function generatePostCall(
  deps: PostCallDeps,
  input: PostCallInput,
): Promise<PostCallResult> {
  const parts = POST_CALL_PARTS.filter((p) => !input.parts?.length || input.parts.includes(p))
  const transcript = input.transcriptText.trim()
  if (!transcript) return allFailed(parts, POST_CALL_MESSAGES.noTranscript)

  const maxTokens = Math.max(1000, input.maxTranscriptTokens ?? DEFAULT_MAX_TRANSCRIPT_TOKENS)
  let body = transcript
  let mapReduce: PostCallResult['mapReduce'] = null
  if (estimateTokens(transcript) > maxTokens) {
    const chunkStats: PostCallCallStats[] = []
    try {
      const condensed = await condense(deps, input, transcript, maxTokens, chunkStats)
      body = condensed.text
      mapReduce = { chunks: condensed.chunks, stats: chunkStats }
    } catch (err) {
      deps.log?.warn('post-call: condensing the long transcript failed', err)
      const message = `${POST_CALL_MESSAGES.longTranscriptFailed} ${errorMessage(err)}`
      const chunks = splitTranscript(transcript, maxTokens).length
      return allFailed(parts, message, { mapReduce: { chunks, stats: chunkStats } })
    }
  }

  const condensed = mapReduce !== null
  const wanted = (part: PostCallPart) => parts.includes(part)
  // The requests run in parallel; total time is the slowest one, not the sum.
  const [notes, actions, email] = await Promise.all([
    wanted('notes') ? runPart(deps, input, 'notes', body, condensed, parseNotes) : null,
    wanted('actions') ? runPart(deps, input, 'actions', body, condensed, parseActionItems) : null,
    wanted('email') ? runPart(deps, input, 'email', body, condensed, parseEmail) : null,
  ])

  const result: PostCallResult = {
    notes: notes?.ok ? notes.value : null,
    actionItems: actions?.ok ? actions.value : null,
    email: email?.ok ? email.value : null,
    errors: [],
    stats: [],
    mapReduce,
  }
  for (const [part, outcome] of [
    ['notes', notes],
    ['actions', actions],
    ['email', email],
  ] as const) {
    if (!outcome) continue
    if (outcome.stats) result.stats.push(outcome.stats)
    if (!outcome.ok) result.errors.push({ part, message: outcome.message })
  }
  return result
}
