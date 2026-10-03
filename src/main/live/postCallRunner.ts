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
   * even an edited email, except when it retries an email failure the user has since resolved by
   * writing the email themselves (see emailFailureResolved).
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
      if (parts.length === 0) {
        // Only a resolved email failure was asked for: nothing to generate, just drop its error.
        const errors = mergeErrors(before.summary.postCallError, [], [], ['email'])
        sessions.updateSummaryJson(sessionId, { postCallError: formatErrors(errors) })
        sessions.setStatus(sessionId, this.finalStatus(sessionId))
        return
      }
      sessions.setStatus(sessionId, 'processing')
      this.ctx.events.broadcast('sessions:changed', { id: sessionId })
      const lines = transcript.listBySession(sessionId, { finalOnly: true })
      const fallbackTitle = fallbackTitleFor(sessions.get(sessionId)?.startedAt ?? Date.now())
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
      this.applyTitle(sessionId, result.notes?.title ?? '', fallbackTitle)
      if (result.notes) {
        aiMessages.upsertPostCall(sessionId, 'post_notes', renderNotesMarkdown(result.notes))
      }
      if (result.actionItems) {
        // Ticked checkboxes carry over to regenerated items with the same text.
        const stored = actionItems.replaceForSession(sessionId, result.actionItems)
        aiMessages.upsertPostCall(sessionId, 'post_actions', renderActionItemsMarkdown(stored))
      }
      // Read again right before writing: the user may have edited the email while this ran.
      const now = sessions.getSummaryJson(sessionId)
      const email =
        result.email && keepGeneratedEmail(now, before.summary, parts) ? result.email : null
      if (email) aiMessages.upsertPostCall(sessionId, 'post_email', emailToMarkdown(email))
      // Only parts that succeeded are written: a failed part never replaces (nulls) earlier
      // output, so the page, search (post_* rows) and exports keep agreeing.
      const resolved: PostCallPart[] =
        emailFailureResolved(before.summary) || emailEditedDuringRun(now, before.summary)
          ? ['email']
          : []
      const errors = mergeErrors(now.postCallError, parts, result.errors, resolved)
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

  /**
   * Auto-title: the notes' title, or a dated fallback when notes failed or have no title. A later
   * run whose notes succeed replaces that fallback. A name the user gave is never replaced. Without a
   * stored flag, a name identical to the fallback counts as the fallback.
   */
  private applyTitle(sessionId: string, generated: string, fallback: string): void {
    const { sessions } = this.history
    const title = generated.trim()
    if (sessions.setTitleIfEmpty(sessionId, title || fallback)) return
    if (title && sessions.get(sessionId)?.title === fallback) sessions.rename(sessionId, title)
  }

  /** 'done' while the session has any output; 'failed' only when every part is missing. */
  private finalStatus(sessionId: string): SessionStatus {
    const { has } = this.existing(sessionId)
    return has.notes || has.actions || has.email ? 'done' : 'failed'
  }
}

/** Title of a meeting whose notes did not give one, e.g. "Meeting on Oct 3". */
function fallbackTitleFor(startedAt: number): string {
  const date = new Date(startedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return t('live.untitledMeeting', { date })
}

function isEmailEdited(summary: SessionSummaryJson): boolean {
  return summary.emailEdited === true && summary.email !== null
}

/**
 * The email part failed, and the user then wrote the follow-up email themselves (the Email tab is
 * editable while there is none). That failure is resolved: retrying it must not replace what they
 * wrote, even though the failed-parts banner still names 'email', and its error is cleared.
 * A generated email the user edited carries no email error (a successful run clears it), so an
 * explicit 'email' still regenerates that one. A blank email (typed, then cleared) is nothing to
 * keep, so its failure is still retried.
 */
function emailFailureResolved(summary: SessionSummaryJson): boolean {
  const written = !!summary.email && !!(summary.email.subject.trim() || summary.email.body.trim())
  return written && isEmailEdited(summary) && parseErrors(summary.postCallError).has('email')
}

/** The user saved an email while this run was going. */
function emailEditedDuringRun(now: SessionSummaryJson, before: SessionSummaryJson): boolean {
  return isEmailEdited(now) && JSON.stringify(now.email) !== JSON.stringify(before.email)
}

/** See PostCallRunOptions.parts. */
function partsToRun(
  existing: ExistingOutput,
  requested: readonly PostCallPart[] | undefined,
): PostCallPart[] {
  if (requested?.length) {
    const keepEmail = emailFailureResolved(existing.summary)
    return POST_CALL_PARTS.filter((p) => requested.includes(p) && !(p === 'email' && keepEmail))
  }
  const missing = POST_CALL_PARTS.filter((p) => !existing.has[p])
  if (missing.length > 0) return missing
  const emailEdited = isEmailEdited(existing.summary)
  return POST_CALL_PARTS.filter((p) => !(p === 'email' && emailEdited))
}

/**
 * A generated email replaces the stored one unless the user edited it while this run was going.
 * An email edited before the run is only regenerated when 'email' was explicitly asked for (see
 * partsToRun), so its part running at all is that consent.
 */
function keepGeneratedEmail(
  now: SessionSummaryJson,
  before: SessionSummaryJson,
  ran: readonly PostCallPart[],
): boolean {
  if (!isEmailEdited(now)) return true
  return !emailEditedDuringRun(now, before) && ran.includes('email')
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
 * time are kept (they are still missing). `resolved` parts were written by the user, so their
 * errors no longer apply.
 */
function mergeErrors(
  stored: string | null,
  ran: readonly PostCallPart[],
  failed: readonly { part: PostCallPart; message: string }[],
  resolved: readonly PostCallPart[],
): PartErrors {
  const errors = parseErrors(stored)
  for (const part of ran) errors.delete(part)
  for (const e of failed) errors.set(e.part, e.message)
  for (const part of resolved) errors.delete(part)
  return errors
}
