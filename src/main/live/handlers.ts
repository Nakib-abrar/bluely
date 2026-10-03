import type { CoreContext } from '../context'
import { handle } from '../ipc/registry'
import type { AiService } from './aiService'
import type { NoticeCenter } from './notices'
import type { SessionManager } from './sessionManager'

/** IPC for the live session, live AI, meeting chat, ask-across-meetings and notices. */
export function registerLiveHandlers(
  _ctx: CoreContext,
  deps: { session: SessionManager; ai: AiService; notices: NoticeCenter },
): void {
  const { session, ai, notices } = deps

  handle('session:start', ({ modeId }) => session.start(modeId))
  // Resolves once the call has ended (status 'processing'); the notes continue in the background.
  handle('session:stop', () => session.stop())
  handle('session:getState', () => session.getState())
  handle('session:getTranscript', ({ sessionId }) => session.getTranscript(sessionId))
  handle('session:dismissConsent', () => session.dismissConsent())
  // A per-call override (see SessionManager.setAutoSuggest); Settings › General keeps the default.
  handle('session:setAutoSuggest', ({ enabled }) => session.setAutoSuggest(enabled))

  handle('audio:segment', (req) => ({ accepted: session.acceptSegment(req) }))
  handle('audio:channelStatus', ({ sessionId, channel, state, error, code }) =>
    session.setChannelStatus(sessionId, channel, state, error, code ?? null),
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

  handle('sessions:regenerate', ({ id, parts }) => session.regenerate(id, parts))
  handle('sessions:chat', ({ id, question }) => ({ id: ai.startMeetingChat(id, question) }))
  handle('search:ask', ({ question }) => ({ id: ai.startSearchAsk(question) }))

  handle('app:getNotices', () => notices.list())
  handle('app:dismissNotice', ({ id }) => {
    notices.dismiss(id)
  })
}
