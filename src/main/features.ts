import type { OverlayCommand } from '@shared/types'
import type { CoreContext } from './context'
import { wireModels } from './models/wire'
import { wireStt } from './stt/wire'
import { wireModes } from './modes/wire'
import { wireHistory } from './history/wire'
import { wireShortcuts } from './shortcuts'
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

  const shortcuts = wireShortcuts(ctx, {
    toggleOverlay: () => {
      ctx.overlay.toggle()
    },
    askAssist: () => {
      ctx.overlay.focus()
      sendOverlayCommand(ctx, { type: 'assist' })
    },
    stopSession: () => {
      void session.stop()
    },
    moveOverlay: (dx, dy) => ctx.overlay.moveBy(dx, dy),
    runAction: (action) => {
      if (!ctx.overlay.isVisible()) ctx.overlay.show(false)
      session.notifyManualRequest()
      ai.startLive({ kind: action })
    },
  })

  return {
    isLive: () => session.isLive(),
    toggleSession: () => session.toggle(),
    shutdown: async () => {
      shortcuts.dispose()
      await session.shutdown()
      history.retention.dispose()
      await models.dispose()
    },
  }
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
