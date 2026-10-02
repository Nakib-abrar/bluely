import { writeFile } from 'node:fs/promises'
import {
  app,
  clipboard,
  dialog,
  type BrowserWindow,
  type SaveDialogOptions,
  type SaveDialogReturnValue,
} from 'electron'
import { BUILTIN_MODES, DEFAULT_MODE_ID } from '@shared/builtinModes'
import type { SessionSummary } from '@shared/types'
import type { CoreContext } from '../context'
import { deleteAllData } from '../data/deleteAll'
import {
  emailToMarkdown,
  exportAllZip,
  exportZipFileName,
  mailtoUrl,
  markdownFileName,
  sessionToMarkdown,
} from '../data/export'
import { ht } from '../data/messages'
import { recoverUnfinishedSessions } from '../data/recovery'
import { RetentionScheduler } from '../data/retention'
import { ActionItemsRepo } from '../db/repos/actionItemsRepo'
import { AiMessagesRepo } from '../db/repos/aiMessagesRepo'
import { SessionsRepo } from '../db/repos/sessionsRepo'
import { TranscriptRepo } from '../db/repos/transcriptRepo'
import { SearchService } from '../db/search'
import { AppError } from '../errors'
import { handle } from '../ipc/registry'
import { openExternalSafe } from '../windows/security'

/** Services the history slice offers to the rest of the app (session manager, AI, notices). */
export interface HistoryFeature {
  sessions: SessionsRepo
  transcript: TranscriptRepo
  aiMessages: AiMessagesRepo
  actionItems: ActionItemsRepo
  search: SearchService
  /** Sessions a crash left unfinished, recovered at startup ("Generate notes?"). */
  recovered: SessionSummary[]
  /** Call `retention.dispose()` on shutdown. */
  retention: RetentionScheduler
}

const BUILTIN_MODE_IDS = new Set(BUILTIN_MODES.map((m) => m.id))

const notFound = () => new AppError('not_found', ht('errSessionNotFound'))

function showSaveDialog(
  win: BrowserWindow | null,
  options: SaveDialogOptions,
): Promise<SaveDialogReturnValue> {
  return win ? dialog.showSaveDialog(win, options) : dialog.showSaveDialog(options)
}

/**
 * Creates the repositories and search service, recovers sessions a crash left unfinished,
 * starts the retention scheduler and registers the history/search/data IPC handlers.
 * Every mutation broadcasts 'sessions:changed'.
 */
export function wireHistory(ctx: CoreContext): HistoryFeature {
  const { db, events, settings } = ctx
  const log = ctx.log.child('history')

  const sessions = new SessionsRepo(db)
  const transcript = new TranscriptRepo(db)
  const aiMessages = new AiMessagesRepo(db)
  const actionItems = new ActionItemsRepo(db)
  const search = new SearchService(db, log)

  // Crash recovery must finish before any live session starts; a failure here must not stop
  // the app from opening.
  let recovered: SessionSummary[] = []
  try {
    const interrupted = aiMessages.markInterrupted()
    recovered = recoverUnfinishedSessions({ sessions, transcript }, Date.now())
    if (recovered.length || interrupted) {
      log.info(
        `Recovered ${recovered.length} unfinished session(s); cancelled ${interrupted} interrupted AI message(s)`,
      )
    }
  } catch (err) {
    log.error('Crash recovery failed', err)
  }

  const changed = (id: string | null) => events.broadcast('sessions:changed', { id })
  const retention = new RetentionScheduler({ db, settings, log, onDeleted: () => changed(null) })

  handle('sessions:list', ({ limit, before }) => sessions.list({ limit, before }))

  handle('sessions:get', ({ id }) => sessions.getDetail(id))

  handle('sessions:rename', ({ id, title }) => {
    if (!sessions.rename(id, title)) throw notFound()
    changed(id)
  })

  handle('sessions:delete', ({ id }) => {
    const s = sessions.get(id)
    if (!s) return // already gone (double click, other window)
    if (s.status === 'active') throw new AppError('session_live', ht('errSessionLive'))
    sessions.delete(id)
    changed(id)
  })

  handle('sessions:updateEmail', ({ id, subject, body }) => {
    const email = { subject, body }
    // summary_json is what the UI shows; the post_email row is what search indexes.
    db.transaction(() => {
      sessions.updateSummaryJson(id, { email })
      aiMessages.upsertPostCall(id, 'post_email', emailToMarkdown(email))
    })()
    changed(id)
  })

  handle('sessions:exportMarkdown', async ({ id, target }, hctx) => {
    const detail = sessions.getDetail(id)
    if (!detail) throw notFound()
    const markdown = sessionToMarkdown(detail)
    if (target === 'clipboard') {
      clipboard.writeText(markdown)
      return { path: null }
    }
    const res = await showSaveDialog(hctx.window, {
      title: ht('dialogExportMarkdown'),
      defaultPath: markdownFileName(detail),
      filters: [{ name: ht('filterMarkdown'), extensions: ['md'] }],
    })
    if (res.canceled || !res.filePath) return { path: null }
    await writeFile(res.filePath, markdown, 'utf8')
    return { path: res.filePath }
  })

  handle('sessions:openMailDraft', async ({ id }) => {
    if (!sessions.get(id)) throw notFound()
    const email = sessions.getSummaryJson(id).email
    if (!email) throw new AppError('no_email', ht('errNoEmail'))
    let opened = false
    try {
      opened = await openExternalSafe(mailtoUrl(email), log)
    } catch (err) {
      // No default mail app registered, or the OS refused the URL.
      log.warn('Opening the mail draft failed', err)
    }
    if (!opened) throw new AppError('mail_failed', ht('errMailBlocked'))
  })

  handle('actionItems:setDone', ({ id, done }) => {
    const item = actionItems.setDone(id, done)
    changed(item.sessionId)
    return item
  })

  handle('search:query', ({ query, limit }) => search.query(query, limit ?? 50))

  handle('data:exportAll', async (_req, hctx) => {
    const res = await showSaveDialog(hctx.window, {
      title: ht('dialogExportAll'),
      defaultPath: exportZipFileName(Date.now()),
      filters: [{ name: ht('filterZip'), extensions: ['zip'] }],
    })
    if (res.canceled || !res.filePath) return { path: null }
    const zip = exportAllZip(db, { version: app.getVersion() })
    await writeFile(res.filePath, zip)
    log.info(`Exported all data (${zip.byteLength} bytes)`)
    return { path: res.filePath }
  })

  handle('data:deleteAll', () => {
    if (sessions.findUnfinished().some((s) => s.status === 'active')) {
      throw new AppError('session_live', ht('errDeleteAllWhileLive'))
    }
    const result = deleteAllData(db, ctx.paths)
    log.info('Deleted all data', result)
    // The active mode may have been a custom mode that no longer exists.
    const activeModeId = settings.get().activeModeId
    const modeExists =
      BUILTIN_MODE_IDS.has(activeModeId) ||
      !!db.prepare('SELECT 1 FROM modes WHERE id = ?').get(activeModeId)
    if (!modeExists) settings.update({ activeModeId: DEFAULT_MODE_ID })
    changed(null)
  })

  return { sessions, transcript, aiMessages, actionItems, search, recovered, retention }
}
