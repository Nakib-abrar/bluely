import {
  dialog,
  ipcMain,
  type BrowserWindow,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
} from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_MODE_ID } from '@shared/builtinModes'
import type { EventChannel, InvokeChannel, IpcEnvelope } from '@shared/ipc'
import type { KnowledgeFile, Mode } from '@shared/types'
import type { CoreContext } from '@main/context'
import { openDatabase, type Db } from '@main/db/database'
import { EventBus } from '@main/ipc/events'
import { _resetRegistryForTests, initIpcRegistry } from '@main/ipc/registry'
import type { Logger } from '@main/log'
import { wireModes, type ModesFeature } from '@main/modes/wire'
import { SettingsStore } from '@main/settings/settingsStore'
import { WindowRegistry } from '@main/windows/registry'
import { tempDir, type TempDir } from './fixtures'

type Listener = Parameters<typeof ipcMain.handle>[1]

const silentLog: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLog,
  setDebug: () => undefined,
}

let db: Db
let settings: SettingsStore
let events: EventBus
let handlers: Map<string, Listener>
let received: { event: EventChannel; payload: unknown }[]
let tmp: TempDir
let feature: ModesFeature

const fakeEvent = {
  senderFrame: { url: 'bluely://app/main/index.html' },
  sender: { id: 1 },
} as unknown as IpcMainInvokeEvent

async function call<T>(channel: InvokeChannel, payload?: unknown): Promise<IpcEnvelope<T>> {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`no handler for ${channel}`)
  return (await fn(fakeEvent, payload)) as IpcEnvelope<T>
}

async function ok<T>(channel: InvokeChannel, payload?: unknown): Promise<T> {
  const res = await call<T>(channel, payload)
  if (!res.ok) throw new Error(`${channel} failed: ${res.error.code} ${res.error.message}`)
  return res.data
}

async function errorCode(channel: InvokeChannel, payload?: unknown): Promise<string> {
  const res = await call(channel, payload)
  if (res.ok) throw new Error(`${channel} unexpectedly succeeded`)
  return res.error.code
}

function wire(): ModesFeature {
  const windows = new WindowRegistry()
  events = new EventBus(windows)
  received = []
  for (const e of ['modes:changed', 'knowledge:changed', 'settings:changed'] as const) {
    events.subscribe(e, (payload) => received.push({ event: e, payload }))
  }
  settings.onChange((next) => events.broadcast('settings:changed', next))
  initIpcRegistry({ windows, log: silentLog, isTrustedUrl: (url) => url.startsWith('bluely://') })
  const ctx = { db, settings, events, windows, log: silentLog } as unknown as CoreContext
  return wireModes(ctx)
}

beforeEach(() => {
  _resetRegistryForTests()
  handlers = new Map()
  vi.spyOn(ipcMain, 'handle').mockImplementation((channel, fn) => {
    handlers.set(channel, fn)
  })
  db = openDatabase(':memory:')
  settings = new SettingsStore(db)
  tmp = tempDir()
})

afterEach(() => tmp.cleanup())

describe('wireModes', () => {
  it('seeds built-ins, registers every modes/knowledge channel and repairs activeModeId', () => {
    settings.update({ activeModeId: 'mode-deleted-elsewhere' })
    feature = wire()
    expect(feature.modes.list()).toHaveLength(6)
    expect(settings.get().activeModeId).toBe(DEFAULT_MODE_ID)
    expect([...handlers.keys()].sort()).toEqual(
      [
        'knowledge:addPaths',
        'knowledge:delete',
        'knowledge:list',
        'knowledge:pickAndAdd',
        'modes:create',
        'modes:delete',
        'modes:list',
        'modes:resetBuiltin',
        'modes:setActive',
        'modes:update',
      ].sort(),
    )
  })

  it('keeps a valid activeModeId and fails interrupted files at startup', () => {
    db.prepare(
      "INSERT INTO modes(id, name, created_at, updated_at) VALUES ('mode-mine', 'Mine', 0, 0)",
    ).run()
    db.prepare(
      "INSERT INTO knowledge_files(id, mode_id, filename, size, status, added_at) VALUES ('f1', 'mode-mine', 'a.txt', 1, 'parsing', 0)",
    ).run()
    settings.update({ activeModeId: 'mode-mine' })
    feature = wire()
    expect(settings.get().activeModeId).toBe('mode-mine')
    expect(feature.knowledge.list('mode-mine')[0]?.status).toBe('failed')
  })

  it('creates, updates, resets and lists Modes over IPC', async () => {
    feature = wire()
    received = []
    const created = await ok<Mode>('modes:create', {
      name: 'Board',
      icon: '🏛️',
      instructions: 'Be brief.',
      tone: 'formal',
      autoSuggest: false,
      modelOverrides: { smart: 'anthropic/claude' },
    })
    expect(created.isBuiltin).toBe(false)
    const updated = await ok<Mode>('modes:update', { id: created.id, patch: { name: 'Board 2' } })
    expect(updated.name).toBe('Board 2')
    expect((await ok<Mode[]>('modes:list')).map((m) => m.name)).toContain('Board 2')

    await ok('modes:update', { id: 'builtin-sales', patch: { name: 'Edited' } })
    expect((await ok<Mode>('modes:resetBuiltin', { id: 'builtin-sales' })).name).toBe('Sales call')
    expect(received.filter((r) => r.event === 'modes:changed')).toHaveLength(4)

    expect(await errorCode('modes:create', { name: '' })).toBe('invalid_payload')
    expect(await errorCode('modes:update', { id: 'mode-x', patch: {} })).toBe('not_found')
    expect(await errorCode('modes:resetBuiltin', { id: created.id })).toBe('not_builtin')
  })

  it('setActive validates the Mode and updates settings', async () => {
    feature = wire()
    await ok('modes:setActive', { id: 'builtin-sales' })
    expect(settings.get().activeModeId).toBe('builtin-sales')
    expect(received.some((r) => r.event === 'settings:changed')).toBe(true)
    expect(await errorCode('modes:setActive', { id: 'mode-nope' })).toBe('not_found')
    expect(settings.get().activeModeId).toBe('builtin-sales')
  })

  it('deleting the active Mode removes its knowledge and re-activates General', async () => {
    feature = wire()
    const mode = await ok<Mode>('modes:create', {
      name: 'Temp',
      icon: '',
      instructions: '',
      tone: 'concise',
      autoSuggest: true,
      modelOverrides: {},
    })
    await ok('modes:setActive', { id: mode.id })
    const files = await ok<KnowledgeFile[]>('knowledge:addPaths', {
      modeId: mode.id,
      paths: [tmp.write('notes.txt', 'Quarterly targets are ambitious.')],
    })
    expect(files[0]?.status).toBe('parsed')
    received = []

    await ok('modes:delete', { id: mode.id })
    expect(feature.modes.get(mode.id)).toBeNull()
    expect(db.prepare('SELECT count(*) c FROM knowledge_chunks').get()).toEqual({ c: 0 })
    expect(settings.get().activeModeId).toBe(DEFAULT_MODE_ID)
    expect(received.map((r) => r.event)).toEqual([
      'knowledge:changed',
      'modes:changed',
      'settings:changed',
    ])
    expect(received[0]?.payload).toEqual({ modeId: mode.id, files: [] })
  })

  it('refuses to delete a built-in without touching its knowledge', async () => {
    feature = wire()
    await ok('knowledge:addPaths', {
      modeId: 'builtin-sales',
      paths: [tmp.write('pricing.md', 'Enterprise costs forty dollars.')],
    })
    expect(await errorCode('modes:delete', { id: 'builtin-sales' })).toBe('builtin_mode')
    expect(feature.knowledge.list('builtin-sales')).toHaveLength(1)
    expect(feature.retriever.search('builtin-sales', 'enterprise', 4)).toHaveLength(1)
  })

  it('pickAndAdd opens a document picker on the calling window and ingests the choice', async () => {
    feature = wire()
    const path = tmp.write('brief.md', 'Discovery questions about budget.')
    const show = vi
      .spyOn(dialog, 'showOpenDialog')
      .mockResolvedValueOnce({ canceled: false, filePaths: [path] })
      .mockResolvedValueOnce({ canceled: true, filePaths: [] })

    const added = await ok<KnowledgeFile[]>('knowledge:pickAndAdd', { modeId: 'builtin-discovery' })
    expect(added.map((f) => [f.filename, f.status])).toEqual([['brief.md', 'parsed']])
    // No window is registered in this test, so the picker is opened unparented.
    const options = show.mock.calls[0]?.[0] as OpenDialogOptions
    expect(options.properties).toEqual(['openFile', 'multiSelections'])
    expect(options.filters).toEqual([
      { name: 'Documents', extensions: ['pdf', 'docx', 'txt', 'md'] },
    ])

    expect(await ok('knowledge:pickAndAdd', { modeId: 'builtin-discovery' })).toEqual([])
    expect(await errorCode('knowledge:pickAndAdd', { modeId: 'mode-x' })).toBe('not_found')
    expect(show).toHaveBeenCalledTimes(2)
  })

  it('passes the sender window to the picker when there is one', async () => {
    const win = { id: 7 } as unknown as BrowserWindow
    vi.spyOn(WindowRegistry.prototype, 'kindOf').mockReturnValue('main')
    vi.spyOn(WindowRegistry.prototype, 'get').mockReturnValue(win)
    feature = wire()
    const show = vi
      .spyOn(dialog, 'showOpenDialog')
      .mockResolvedValue({ canceled: true, filePaths: [] })
    await ok('knowledge:pickAndAdd', { modeId: 'builtin-general' })
    expect(show.mock.calls[0]?.[0]).toBe(win)
  })

  it('lists and deletes knowledge files; validates addPaths payloads', async () => {
    feature = wire()
    const [file] = await ok<KnowledgeFile[]>('knowledge:addPaths', {
      modeId: 'builtin-general',
      paths: [tmp.write('a.txt', 'alpha beta')],
    })
    expect(await ok<KnowledgeFile[]>('knowledge:list', { modeId: 'builtin-general' })).toEqual([
      file,
    ])
    await ok('knowledge:delete', { fileId: file?.id })
    expect(await ok('knowledge:list', { modeId: 'builtin-general' })).toEqual([])
    expect(await errorCode('knowledge:addPaths', { modeId: 'builtin-general', paths: [] })).toBe(
      'invalid_payload',
    )
    expect(await errorCode('knowledge:addPaths', { modeId: 'mode-x', paths: ['/a.txt'] })).toBe(
      'not_found',
    )
  })
})
