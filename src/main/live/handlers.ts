import type { CoreContext } from '../context'
import { handle } from '../ipc/registry'
import type { AiService } from './aiService'
import type { NoticeCenter } from './notices'
import type { SessionManager } from './sessionManager'

/** IPC for the live session, live AI, meeting chat, ask-across-meetings and notices. */
export function registerLiveHandlers(
  ctx: CoreContext,
  deps: { session: SessionManager; ai: AiService; notices: NoticeCenter },
): void {
  const { session, ai, notices } = deps

  handle('session:start', ({ modeId }) => session.start(modeId))
  handle('session:stop', () => {
    void session.stop()
  })
  handle('session:getState', () => session.getState())
  handle('session:getTranscript', ({ sessionId }) => session.getTranscript(sessionId))
  handle('session:dismissConsent', () => session.dismissConsent())
  handle('session:setAutoSuggest', ({ enabled }) => {
    ctx.settings.update({ general: { autoSuggest: enabled } })
  })

  handle('audio:segment', (req) => ({ accepted: session.acceptSegment(req) }))
  handle('audio:channelStatus', ({ sessionId, channel, state, error }) =>
    session.setChannelStatus(sessionId, channel, state, error),
  )
  handle('audio:warning', ({ sessionId, code, active }) =>
    session.setWarning(sessionId, code, active),
  )
  handle('audio:stopped', ({ sessionId }) => session.audioStopped(sessionId))
  handle('audio:speaking', ({ sessionId, channel, speaking }) =>
    session.setSpeaking(sessionId, channel, speaking),
  )

  handle('ai:run', (req) => {
    session.notifyManualRequest()
    const { id } = ai.startLive({
      kind: req.kind,
      question: req.question,
      includeScreen: req.includeScreen,
      tier: req.tier,
    })
    return { id }
  })
  handle('ai:cancel', ({ id }) => ai.cancel(id))
  handle('ai:clear', () => ai.clearLive())
  handle('ai:getCards', ({ scope, sessionId }) => ai.getCards(scope, sessionId))

  handle('sessions:regenerate', ({ id }) => session.regenerate(id))
  handle('sessions:chat', ({ id, question }) => ({ id: ai.startMeetingChat(id, question) }))
  handle('search:ask', ({ question }) => ({ id: ai.startSearchAsk(question) }))

  handle('app:getNotices', () => notices.list())
  handle('app:dismissNotice', ({ id }) => {
    notices.dismiss(id)
  })
}
