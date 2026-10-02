import { dialog, type OpenDialogOptions } from 'electron'
import { DEFAULT_MODE_ID } from '@shared/builtinModes'
import { KNOWLEDGE_LIMITS } from '@shared/constants'
import type { CoreContext } from '../context'
import { AppError } from '../errors'
import { handle } from '../ipc/registry'
import { KnowledgeService } from '../knowledge/ingest'
import { knowledgeMessages } from '../knowledge/messages'
import { Fts5Retriever, type Retriever } from '../knowledge/retriever'
import { ModesRepo } from './modesRepo'

/** Services other features (live session, context builder, settings UI) use. */
export interface ModesFeature {
  modes: ModesRepo
  knowledge: KnowledgeService
  retriever: Retriever
}

/**
 * Creates the Modes + knowledge services, seeds built-in Modes, repairs a dangling
 * `activeModeId`, and registers the 'modes:*' and 'knowledge:*' IPC handlers.
 */
export function wireModes(ctx: CoreContext): ModesFeature {
  const { db, events, settings } = ctx
  const log = ctx.log.child('modes')
  const modes = new ModesRepo({ db, events })
  const knowledge = new KnowledgeService({ db, events, log: ctx.log.child('knowledge') })
  const retriever = new Fts5Retriever(db, ctx.log.child('retriever'))

  modes.ensureBuiltins()
  knowledge.recoverInterrupted()
  if (!modes.get(settings.get().activeModeId)) {
    log.info(`Active Mode ${settings.get().activeModeId} not found; using ${DEFAULT_MODE_ID}`)
    settings.update({ activeModeId: DEFAULT_MODE_ID })
  }

  const requireMode = (id: string) => {
    if (!modes.get(id)) throw new AppError('not_found', knowledgeMessages.modes.notFound)
  }

  handle('modes:list', () => modes.list())
  handle('modes:create', (input) => modes.create(input))
  handle('modes:update', ({ id, patch }) => modes.update(id, patch))
  handle('modes:delete', ({ id }) => {
    modes.assertDeletable(id)
    knowledge.deleteForMode(id)
    modes.delete(id)
    if (settings.get().activeModeId === id) settings.update({ activeModeId: DEFAULT_MODE_ID })
  })
  handle('modes:resetBuiltin', ({ id }) => modes.resetBuiltin(id))
  handle('modes:setActive', ({ id }) => {
    requireMode(id)
    settings.update({ activeModeId: id })
  })

  handle('knowledge:list', ({ modeId }) => knowledge.list(modeId))
  handle('knowledge:pickAndAdd', async ({ modeId }, hctx) => {
    requireMode(modeId)
    const options: OpenDialogOptions = {
      title: knowledgeMessages.dialog.title,
      buttonLabel: knowledgeMessages.dialog.button,
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: knowledgeMessages.dialog.filterName,
          extensions: KNOWLEDGE_LIMITS.extensions.map((e) => e.slice(1)),
        },
      ],
    }
    const result = hctx.window
      ? await dialog.showOpenDialog(hctx.window, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths.length) return []
    return knowledge.addFiles(modeId, result.filePaths)
  })
  handle('knowledge:addPaths', ({ modeId, paths }) => knowledge.addFiles(modeId, paths))
  handle('knowledge:delete', ({ fileId }) => knowledge.delete(fileId))

  return { modes, knowledge, retriever }
}
