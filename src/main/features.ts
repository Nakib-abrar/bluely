import type { OverlayCommand } from '@shared/types'
import type { CoreContext } from './context'
import { wireModels } from './models/wire'
import { wireStt } from './stt/wire'
import { wireModes, type ModesFeature } from './modes/wire'
import { wireHistory, type HistoryFeature } from './history/wire'
import { wireShortcuts, type ShortcutActions } from './shortcuts'
import { wireUpdater } from './updater'
import { isPortableBuild } from './platform'
import { AiService } from './live/aiService'
import { PostCallRunner } from './live/postCallRunner'
import { SessionManager } from './live/sessionManager'
import { NoticeCenter } from './live/notices'
import { registerLiveHandlers } from './live/handlers'

/**
 * Composition root for feature modules (providers, session, knowledge, history, …).
 * Each feature exposes a wire*() function that registers its IPC handlers and returns
 * the services other features need.
 */
export interface Features {
  isLive(): boolean
  /**
   * A call is live, or the notes of one that just ended are still being generated. Closing the
   * main window then minimizes instead of quitting (quitting would abandon that work).
   */
  isBusy(): boolean
  toggleSession(): void
  /** Called once before quitting; must finish quickly. */
  shutdown(): Promise<void>
}

export function wireFeatures(ctx: CoreContext): Features {
  const models = wireModels(ctx)
  const stt = wireStt(ctx, { http: models.http })
  const modes = wireModes(ctx)
  const history = wireHistory(ctx)
  const notices = new NoticeCenter(ctx, history)
  const ai = new AiService(ctx, models, modes, history)
  const postCall = new PostCallRunner(ctx, models, history)
  const session = new SessionManager(ctx, { models, stt, history, modes, ai, postCall })
  registerLiveHandlers(ctx, { session, ai, notices })
  const updater = wireUpdater(ctx, {
    isPortable: isPortableBuild(),
    isSessionLive: () => session.isLive(),
  })

  models.onValidation((results) => notices.setModelValidation(results))
  ctx.events.subscribe('updater:status', (status) => notices.setUpdateStatus(status))
  ctx.secrets.onChange(() => {
    notices.publish()
    ctx.events.broadcast('key:changed', ctx.secrets.status())
  })
  // settings:update accepts any activeModeId string; fall back if it names no Mode.
  ctx.settings.onChange((next) => {
    if (!modes.modes.get(next.activeModeId)) {
      ctx.settings.update({ activeModeId: 'builtin-general' })
    }
  })
  ctx.events.subscribe('sessions:changed', ({ id }) =>
    onSessionsChanged(ctx, { session, ai, history, modes }, id),
  )
  // Capture runs in the overlay renderer; the overlay reloads it after a crash.
  ctx.overlay.onRendererGone(() => session.captureLost())

  const shortcuts = wireShortcuts(ctx, shortcutActions(ctx, { session }))

  return {
    isLive: () => session.isLive(),
    isBusy: () => session.isLive() || session.isPostCallRunning(),
    toggleSession: () => session.toggle(),
    shutdown: async () => {
      shortcuts.dispose()
      updater.dispose()
      await session.shutdown()
      history.retention.dispose()
      await models.dispose()
    },
  }
}

/** What the global shortcuts do. Exported for tests. */
export function shortcutActions(
  ctx: CoreContext,
  deps: { session: Pick<SessionManager, 'stop'> },
): ShortcutActions {
  return {
    toggleOverlay: () => {
      ctx.overlay.toggle()
    },
    askAssist: () => {
      ctx.overlay.focus()
      sendOverlayCommand(ctx, { type: 'assist' })
    },
    stopSession: () => {
      void deps.session.stop()
    },
    moveOverlay: (dx, dy) => ctx.overlay.moveBy(dx, dy),
    runAction: (action) => {
      if (!ctx.overlay.isVisible()) ctx.overlay.show(false)
      // Through the overlay, like its own buttons: it expands the panel, selects Insights so
      // the answer is visible, and calls ai:run (which cancels a pending auto-suggestion).
      sendOverlayCommand(ctx, { type: 'action', action })
    },
  }
}

/**
 * Data was deleted ('sessions:delete', 'data:deleteAll', retention). The overlay's answers
 * and transcript of the last call live in memory after it ends; once that session is gone they
 * are cleared too, so a deleted meeting never reappears in the overlay. 'Delete all' also
 * removes custom Modes and files without going through the Modes repo, so their lists are
 * re-broadcast.
 */
export function onSessionsChanged(
  ctx: CoreContext,
  deps: {
    session: Pick<SessionManager, 'isLive' | 'lastSessionId' | 'forgetLastSession'>
    ai: Pick<AiService, 'clearLive'>
    history: Pick<HistoryFeature, 'sessions'>
    modes: ModesFeature
  },
  id: string | null,
): void {
  if (id === null) {
    const list = deps.modes.modes.list()
    ctx.events.broadcast('modes:changed', list)
    for (const mode of list) {
      ctx.events.broadcast('knowledge:changed', {
        modeId: mode.id,
        files: deps.modes.knowledge.list(mode.id),
      })
    }
  }
  if (deps.session.isLive()) return
  const last = deps.session.lastSessionId()
  if (!last || (id !== null && id !== last) || deps.history.sessions.get(last)) return
  deps.session.forgetLastSession()
  deps.ai.clearLive()
}

/** Delivers a command to the overlay renderer, waiting for its first load if needed. */
function sendOverlayCommand(ctx: CoreContext, command: OverlayCommand): void {
  const win = ctx.overlay.window
  if (!win) return
  const send = () => ctx.events.sendTo('overlay', 'overlay:command', command)
  if (win.webContents.isLoading())
    win.webContents.once('did-finish-load', () => setTimeout(send, 50))
  else send()
}
