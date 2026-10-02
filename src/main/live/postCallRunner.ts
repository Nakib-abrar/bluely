import { t } from '@shared/i18n'
import type { Mode } from '@shared/types'
import type { CoreContext } from '../context'
import { generatePostCall } from '../ai/postCall'
import { renderActionItemsMarkdown, renderNotesMarkdown } from '../ai/markdown'
import { formatTranscript } from '../ai/format'
import { emailToMarkdown } from '../data/export'
import type { ModelsFeature } from '../models/wire'
import { routingFor } from '../models/wire'
import type { HistoryFeature } from '../history/wire'

/**
 * Generates notes, action items and the follow-up email for a finished session (Notes model,
 * three requests in parallel) and stores them. Each part may fail independently.
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

  async run(sessionId: string, mode: Mode): Promise<void> {
    if (this.running.has(sessionId)) return
    this.running.add(sessionId)
    const { sessions, transcript, actionItems, aiMessages } = this.history
    const settings = this.ctx.settings.get()
    try {
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
        },
      )
      if (result.notes) {
        sessions.setTitleIfEmpty(sessionId, result.notes.title || fallbackTitle)
        aiMessages.upsertPostCall(sessionId, 'post_notes', renderNotesMarkdown(result.notes))
      } else {
        sessions.setTitleIfEmpty(sessionId, fallbackTitle)
      }
      if (result.actionItems) {
        actionItems.replaceForSession(sessionId, result.actionItems)
        aiMessages.upsertPostCall(
          sessionId,
          'post_actions',
          renderActionItemsMarkdown(result.actionItems.map((i) => ({ ...i, done: false }))),
        )
      }
      if (result.email)
        aiMessages.upsertPostCall(sessionId, 'post_email', emailToMarkdown(result.email))
      sessions.updateSummaryJson(sessionId, {
        notes: result.notes,
        email: result.email,
        postCallError: result.errors.length
          ? result.errors.map((e) => `${e.part}: ${e.message}`).join(' · ')
          : null,
      })
      // LLM usage for these requests is logged by the models feature (onFinished hook).
      const allFailed = !result.notes && !result.actionItems && !result.email
      sessions.setStatus(sessionId, allFailed ? 'failed' : 'done')
    } catch (err) {
      // The session may have been deleted while notes were generating.
      if (!sessions.get(sessionId)) return
      this.ctx.log.error('Post-call generation failed', err)
      try {
        sessions.updateSummaryJson(sessionId, {
          postCallError: err instanceof Error ? err.message : String(err),
        })
        sessions.setStatus(sessionId, 'failed')
      } catch {
        /* deleted concurrently */
      }
    } finally {
      this.running.delete(sessionId)
      this.ctx.events.broadcast('sessions:changed', { id: sessionId })
    }
  }
}
