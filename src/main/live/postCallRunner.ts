import { t } from '@shared/i18n'
import type { Mode, SessionStatus, SessionSummaryJson } from '@shared/types'
import type { CoreContext } from '../context'
import { generatePostCall, POST_CALL_PARTS, type PostCallPart } from '../ai/postCall'
import { renderActionItemsMarkdown, renderNotesMarkdown } from '../ai/markdown'
import { formatTranscript } from '../ai/format'
import { emailToMarkdown } from '../data/export'
import type { ModelsFeature } from '../models/wire'
import { routingFor } from '../models/wire'
import type { HistoryFeature } from '../history/wire'

export interface PostCallRunOptions {
  /**
   * Parts to (re)generate. Default: the parts the session is missing; when nothing is missing,
   * all of them except a follow-up email the user has edited. Naming 'email' explicitly replaces
   * even an edited email.
   */
  parts?: readonly PostCallPart[]
}

/** What a session already has, read before a run. */
interface ExistingOutput {
  summary: SessionSummaryJson
  has: Record<PostCallPart, boolean>
}

/**
 * Generates notes, action items and the follow-up email for a finished session (Notes model,
 * requests in parallel) and stores them. Each part may fail independently, and a part that fails
 * never replaces what the session already had: regenerating is safe to retry.
 */
export class PostCallRunner {
  private running = new Set<string>()

  constructor(
    private readonly ctx: CoreContext,
    private readonly models: ModelsFeature,
    private readonly history: HistoryFeature,
  ) {}

  isRunning(sessionId: string): boolean {
    return this.running.has(sessionId)
  }

  async run(sessionId: string, mode: Mode, opts: PostCallRunOptions = {}): Promise<void> {
    if (this.running.has(sessionId)) return
    this.running.add(sessionId)
    const { sessions, transcript, actionItems, aiMessages } = this.history
    const settings = this.ctx.settings.get()
    try {
      const before = this.existing(sessionId)
      const parts = partsToRun(before, opts.parts)
      sessions.setStatus(sessionId, 'processing')
      this.ctx.events.broadcast('sessions:changed', { id: sessionId })
      const lines = transcript.listBySession(sessionId, { finalOnly: true })
      const summary = sessions.get(sessionId)
      const fallbackTitle = t('live.untitledMeeting', {
        date: new Date(summary?.startedAt ?? Date.now()).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
        }),
      })
      if (lines.length === 0) {
        sessions.setTitleIfEmpty(sessionId, t('live.emptySession'))
        sessions.updateSummaryJson(sessionId, { postCallError: t('live.noTranscript') })
        sessions.setStatus(sessionId, 'done')
        return
      }
      const model = mode.modelOverrides.notes || settings.models.notes.model
      const result = await generatePostCall(
        { llm: this.models.llm },
        {
          model,
          routing: routingFor(settings.models.notes),
          transcriptText: formatTranscript(lines),
          mode,
          profile: settings.profile,
          answerLanguage: settings.language.answer,
          parts,
        },
      )
      if (result.notes) {
        sessions.setTitleIfEmpty(sessionId, result.notes.title || fallbackTitle)
        aiMessages.upsertPostCall(sessionId, 'post_notes', renderNotesMarkdown(result.notes))
      } else {
        sessions.setTitleIfEmpty(sessionId, fallbackTitle)
      }
      if (result.actionItems) {
        // Ticked checkboxes carry over to regenerated items with the same text.
        const stored = actionItems.replaceForSession(sessionId, result.actionItems)
        aiMessages.upsertPostCall(sessionId, 'post_actions', renderActionItemsMarkdown(stored))
      }
      // Read again right before writing: the user may have edited the email while this ran.
      const now = sessions.getSummaryJson(sessionId)
      const email =
        result.email && keepGeneratedEmail(now, before.summary, opts.parts) ? result.email : null
      if (email) aiMessages.upsertPostCall(sessionId, 'post_email', emailToMarkdown(email))
      // Only parts that succeeded are written: a failed part never replaces (nulls) earlier
      // output, so the page, search (post_* rows) and exports keep agreeing.
      const errors = mergeErrors(now.postCallError, parts, result.errors)
      sessions.updateSummaryJson(sessionId, {
        ...(result.notes ? { notes: result.notes } : {}),
        ...(email ? { email, emailEdited: false } : {}),
        postCallError: formatErrors(errors),
      })
      // LLM usage for these requests is logged by the models feature (onFinished hook).
      sessions.setStatus(sessionId, this.finalStatus(sessionId))
    } catch (err) {
      // The session may have been deleted while notes were generating.
      if (!sessions.get(sessionId)) return
      this.ctx.log.error('Post-call generation failed', err)
      try {
        sessions.updateSummaryJson(sessionId, {
          postCallError: err instanceof Error ? err.message : String(err),
        })
        sessions.setStatus(sessionId, this.finalStatus(sessionId))
      } catch {
        /* deleted concurrently */
      }
    } finally {
      this.running.delete(sessionId)
      this.ctx.events.broadcast('sessions:changed', { id: sessionId })
    }
  }

  private existing(sessionId: string): ExistingOutput {
    const { sessions, actionItems, aiMessages } = this.history
    const summary = sessions.getSummaryJson(sessionId)
    return {
      summary,
      has: {
        notes: summary.notes !== null,
        // A meeting without action items still has its (empty) post_actions row.
        actions:
          actionItems.listBySession(sessionId).length > 0 ||
          aiMessages.listBySession(sessionId, ['post_actions']).length > 0,
        email: summary.email !== null,
      },
    }
  }

  /** 'done' while the session has any output; 'failed' only when every part is missing. */
  private finalStatus(sessionId: string): SessionStatus {
    const { has } = this.existing(sessionId)
    return has.notes || has.actions || has.email ? 'done' : 'failed'
  }
}

function isEmailEdited(summary: SessionSummaryJson): boolean {
  return summary.emailEdited === true && summary.email !== null
}

/** See PostCallRunOptions.parts. */
function partsToRun(
  existing: ExistingOutput,
  requested: readonly PostCallPart[] | undefined,
): PostCallPart[] {
  if (requested?.length) return POST_CALL_PARTS.filter((p) => requested.includes(p))
  const missing = POST_CALL_PARTS.filter((p) => !existing.has[p])
  if (missing.length > 0) return missing
  const emailEdited = isEmailEdited(existing.summary)
  return POST_CALL_PARTS.filter((p) => !(p === 'email' && emailEdited))
}

/**
 * A generated email replaces the stored one unless the user edited it, either before this run
 * (and did not explicitly ask for a new email) or while it was running.
 */
function keepGeneratedEmail(
  now: SessionSummaryJson,
  before: SessionSummaryJson,
  requested: readonly PostCallPart[] | undefined,
): boolean {
  if (!isEmailEdited(now)) return true
  const editedDuringRun = JSON.stringify(now.email) !== JSON.stringify(before.email)
  return !editedDuringRun && !!requested?.includes('email')
}

type PartErrors = Map<PostCallPart, string>

const PART_ERROR = /^(notes|actions|email): (.+)$/s
/**
 * Splits only where the next "<part>: " entry starts, so a message that itself contains " · "
 * (e.g. a provider's error detail) stays whole. Same rule as the renderer's parsePostCallError.
 */
const PART_ERROR_SEPARATOR = / · (?=(?:notes|actions|email): )/

/**
 * Inverse of formatErrors: "notes: msg · email: msg" → per-part messages. Text that is not a
 * per-part entry (a whole-run failure, "nothing was transcribed") is dropped: the run that reads
 * it replaces it.
 */
function parseErrors(stored: string | null): PartErrors {
  const out: PartErrors = new Map()
  for (const entry of (stored ?? '').split(PART_ERROR_SEPARATOR)) {
    const match = PART_ERROR.exec(entry.trim())
    if (match) out.set(match[1] as PostCallPart, match[2] as string)
  }
  return out
}

function formatErrors(errors: PartErrors): string | null {
  const segments = POST_CALL_PARTS.filter((p) => errors.has(p)).map(
    (p) => `${p}: ${errors.get(p) ?? ''}`,
  )
  return segments.length ? segments.join(' · ') : null
}

/**
 * The parts that ran report their own outcome; earlier errors of parts that did not run this
 * time are kept (they are still missing).
 */
function mergeErrors(
  stored: string | null,
  ran: readonly PostCallPart[],
  failed: readonly { part: PostCallPart; message: string }[],
): PartErrors {
  const errors = parseErrors(stored)
  for (const part of ran) errors.delete(part)
  for (const e of failed) errors.set(e.part, e.message)
  return errors
}
