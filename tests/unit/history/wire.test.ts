import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clipboard, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { strFromU8, unzipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CoreContext } from '@main/context'
import { openDatabase, type Db } from '@main/db/database'
import type { Env } from '@main/env'
import { wireHistory, type HistoryFeature } from '@main/history/wire'
import { EventBus } from '@main/ipc/events'
import { _resetRegistryForTests, initIpcRegistry } from '@main/ipc/registry'
import { createLogger } from '@main/log'
import { SecretStore } from '@main/settings/secrets'
import { SettingsStore } from '@main/settings/settingsStore'
import { WindowRegistry } from '@main/windows/registry'
import type { OverlayController } from '@main/windows/overlayWindow'
import type { InvokeChannel, IpcEnvelope } from '@shared/ipc'
import { line } from './fixtures'

type Listener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

let dir: string
let db: Db
let ctx: CoreContext
let feature: HistoryFeature | null
let handlers: Map<string, Listener>
let changes: (string | null)[]

function makeCtx(): CoreContext {
  const log = createLogger(null)
  const windows = new WindowRegistry()
  const env: Env = {
    isDev: true,
    isPackaged: false,
    isTest: true,
    rendererUrl: null,
    openRouterBaseUrl: 'http://127.0.0.1:1',
    verbose: false,
  }
  return {
    env,
    paths: {
      userData: dir,
      dbFile: join(dir, 'bluely.db'),
      keyFile: join(dir, 'key.bin'),
      logsDir: join(dir, 'logs'),
      screenshotsDir: join(dir, 'screenshots'),
    },
    log,
    db,
    settings: new SettingsStore(db),
    secrets: new SecretStore(join(dir, 'key.bin')),
    events: new EventBus(windows),
    windows,
    overlay: {} as unknown as OverlayController,
    showMainWindow: () => undefined,
  }
}

async function invoke<T = unknown>(
  channel: InvokeChannel,
  payload?: unknown,
): Promise<IpcEnvelope<T>> {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`no handler for ${channel}`)
  const event = {
    senderFrame: { url: 'bluely://app/main/index.html' },
    sender: { id: 1 },
  } as unknown as IpcMainInvokeEvent
  return (await fn(event, payload)) as IpcEnvelope<T>
}

async function ok<T>(channel: InvokeChannel, payload?: unknown): Promise<T> {
  const res = await invoke<T>(channel, payload)
  if (!res.ok) throw new Error(`${channel} failed: ${res.error.code} ${res.error.message}`)
  return res.data
}

async function errorCode(channel: InvokeChannel, payload?: unknown): Promise<string> {
  const res = await invoke(channel, payload)
  if (res.ok) throw new Error(`${channel} unexpectedly succeeded`)
  return res.error.code
}

function wire(): HistoryFeature {
  feature = wireHistory(ctx)
  ctx.events.subscribe('sessions:changed', ({ id }) => changes.push(id))
  return feature
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bluely-history-wire-'))
  db = openDatabase(':memory:')
  ctx = makeCtx()
  handlers = new Map()
  changes = []
  feature = null
  _resetRegistryForTests()
  vi.spyOn(ipcMain, 'handle').mockImplementation((channel, listener) => {
    handlers.set(channel, listener as Listener)
  })
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  initIpcRegistry({
    windows: ctx.windows,
    log: ctx.log,
    isTrustedUrl: (u) => u.startsWith('bluely://app/'),
  })
})

afterEach(() => {
  feature?.retention.dispose()
  _resetRegistryForTests()
  rmSync(dir, { recursive: true, force: true })
})

describe('wireHistory', () => {
  it('registers every history, search and data handler', () => {
    wire()
    expect([...handlers.keys()].sort()).toEqual(
      [
        'actionItems:setDone',
        'data:deleteAll',
        'data:exportAll',
        'search:query',
        'sessions:delete',
        'sessions:exportMarkdown',
        'sessions:get',
        'sessions:list',
        'sessions:openMailDraft',
        'sessions:rename',
        'sessions:updateEmail',
      ].sort(),
    )
  })

  it('recovers crashed sessions and interrupted AI messages at startup', () => {
    const now = Date.now()
    db.prepare(
      "INSERT INTO sessions(id, title, started_at, status, created_at) VALUES ('crashed', '', ?, 'active', ?)",
    ).run(now - 60_000, now)
    db.prepare(
      "INSERT INTO transcript_lines(id, session_id, channel, start_ms, end_ms, text, is_final) VALUES ('l1', 'crashed', 'them', 0, 4200, 'hello', 1)",
    ).run()
    db.prepare(
      "INSERT INTO ai_messages(id, session_id, kind, status, created_at) VALUES ('m1', 'crashed', 'say', 'streaming', ?)",
    ).run(now)
    const f = wire()
    expect(f.recovered).toMatchObject([
      { id: 'crashed', status: 'recovered', endedAt: now - 60_000 + 4200 },
    ])
    expect(f.aiMessages.get('m1')?.status).toBe('cancelled')
  })

  it('applies retention at startup', () => {
    ctx.settings.update({ privacy: { retentionDays: 30 } })
    db.prepare(
      "INSERT INTO sessions(id, title, started_at, status, created_at) VALUES ('old', 'Old', 1, 'done', 1)",
    ).run()
    const f = wire()
    expect(f.sessions.get('old')).toBeNull()
  })

  it('lists, gets, renames and deletes sessions with change events', async () => {
    const f = wire()
    f.sessions.create({ id: 'a', modeId: 'builtin-general', startedAt: 1000 })
    f.sessions.create({ id: 'b', modeId: null, startedAt: 2000 })
    f.sessions.setStatus('a', 'done')
    f.sessions.setStatus('b', 'done')
    f.transcript.upsert(line('a', 'me', 0, 'Hello there'))

    expect((await ok<{ id: string }[]>('sessions:list', {})).map((s) => s.id)).toEqual(['b', 'a'])
    expect(
      (await ok<{ id: string }[]>('sessions:list', { limit: 1, before: 2000 })).map((s) => s.id),
    ).toEqual(['a'])
    expect(await errorCode('sessions:list', { limit: 0 })).toBe('invalid_payload')

    const detail = await ok<{ modeName: string; transcript: unknown[] }>('sessions:get', {
      id: 'a',
    })
    expect(detail.modeName).toBe('General meeting')
    expect(detail.transcript).toHaveLength(1)
    expect(await ok('sessions:get', { id: 'missing' })).toBeNull()

    await ok('sessions:rename', { id: 'a', title: '  Kickoff  ' })
    expect(f.sessions.get('a')?.title).toBe('Kickoff')
    expect(await errorCode('sessions:rename', { id: 'missing', title: 'x' })).toBe('not_found')
    expect(await errorCode('sessions:rename', { id: 'a', title: '   ' })).toBe('invalid_payload')

    await ok('sessions:delete', { id: 'a' })
    expect(f.sessions.get('a')).toBeNull()
    await ok('sessions:delete', { id: 'a' }) // idempotent, no event
    f.sessions.create({ id: 'live', modeId: null, startedAt: 3000 })
    expect(await errorCode('sessions:delete', { id: 'live' })).toBe('session_live')
    expect(changes).toEqual(['a', 'a'])
  })

  it('saves the edited follow-up email to summary_json and the search index', async () => {
    const f = wire()
    f.sessions.create({ id: 's', modeId: null, startedAt: 1 })
    f.sessions.setStatus('s', 'done')
    await ok('sessions:updateEmail', {
      id: 's',
      subject: 'Pricing recap',
      body: 'Hi Sam,\nthe quote is attached.',
    })
    expect(f.sessions.getSummaryJson('s').email).toEqual({
      subject: 'Pricing recap',
      body: 'Hi Sam,\nthe quote is attached.',
    })
    await ok('sessions:updateEmail', {
      id: 's',
      subject: 'Pricing recap',
      body: 'Hi Sam,\nthe invoice is attached.',
    })
    expect(f.aiMessages.listBySession('s', ['post_email'])).toHaveLength(1)
    const res = await ok<{ groups: { session: { id: string }; hits: { kind: string }[] }[] }>(
      'search:query',
      { query: 'invoice' },
    )
    expect(res.groups[0]?.hits[0]?.kind).toBe('email')
    expect((await ok<{ groups: unknown[] }>('search:query', { query: 'quote' })).groups).toEqual([])
    expect(await errorCode('sessions:updateEmail', { id: 'missing', subject: '', body: '' })).toBe(
      'not_found',
    )
    expect(f.aiMessages.listBySession('missing')).toEqual([])
    expect(changes).toEqual(['s', 's'])
  })

  it('exports one session as Markdown to the clipboard or a file', async () => {
    const f = wire()
    f.sessions.create({ id: 's', modeId: null, startedAt: Date.UTC(2026, 0, 10, 3, 3) })
    f.sessions.rename('s', 'Pricing: review')
    f.transcript.upsert(line('s', 'them', 1000, 'What does it cost?'))
    const write = vi.spyOn(clipboard, 'writeText').mockImplementation(() => undefined)
    expect(await ok('sessions:exportMarkdown', { id: 's', target: 'clipboard' })).toEqual({
      path: null,
    })
    expect(write).toHaveBeenCalledWith(expect.stringContaining('# Pricing: review'))
    expect(write.mock.calls[0]?.[0]).toContain('**Them** [00:01]: What does it cost?')

    const target = join(dir, 'out.md')
    const save = vi
      .spyOn(dialog, 'showSaveDialog')
      .mockResolvedValueOnce({ canceled: false, filePath: target })
      .mockResolvedValueOnce({ canceled: true, filePath: '' })
    expect(await ok('sessions:exportMarkdown', { id: 's', target: 'file' })).toEqual({
      path: target,
    })
    expect(readFileSync(target, 'utf8')).toContain('# Pricing: review')
    const options = save.mock.calls[0]?.[0] as unknown as {
      defaultPath: string
      filters: { extensions: string[] }[]
    }
    expect(options.defaultPath).toMatch(/^2026-01-1\d Pricing review\.md$/)
    expect(options.filters[0]?.extensions).toEqual(['md'])
    expect(await ok('sessions:exportMarkdown', { id: 's', target: 'file' })).toEqual({ path: null })
    expect(await errorCode('sessions:exportMarkdown', { id: 'missing', target: 'file' })).toBe(
      'not_found',
    )
  })

  it('opens the follow-up email as a mailto: draft', async () => {
    const f = wire()
    f.sessions.create({ id: 's', modeId: null, startedAt: 1 })
    const open = vi.spyOn(shell, 'openExternal').mockResolvedValue(undefined)
    expect(await errorCode('sessions:openMailDraft', { id: 's' })).toBe('no_email')
    expect(await errorCode('sessions:openMailDraft', { id: 'missing' })).toBe('not_found')
    f.sessions.updateSummaryJson('s', { email: { subject: 'Hi there', body: 'Line 1\nLine 2' } })
    await ok('sessions:openMailDraft', { id: 's' })
    expect(open).toHaveBeenCalledWith('mailto:?subject=Hi%20there&body=Line%201%0D%0ALine%202')
    open.mockRejectedValueOnce(new Error('no handler'))
    expect(await errorCode('sessions:openMailDraft', { id: 's' })).toBe('mail_failed')
  })

  it('persists action item checkboxes', async () => {
    const f = wire()
    f.sessions.create({ id: 's', modeId: null, startedAt: 1 })
    const [item] = f.actionItems.replaceForSession('s', [
      { text: 'Send deck', owner: null, due: null },
    ])
    const updated = await ok<{ id: string; done: boolean }>('actionItems:setDone', {
      id: item?.id,
      done: true,
    })
    expect(updated).toMatchObject({ id: item?.id, done: true })
    expect(f.actionItems.listBySession('s')[0]?.done).toBe(true)
    expect(await errorCode('actionItems:setDone', { id: 'nope', done: true })).toBe('not_found')
    expect(changes).toEqual(['s'])
  })

  it('searches, with a default limit and safe handling of odd input', async () => {
    const f = wire()
    for (let i = 0; i < 60; i++) {
      f.sessions.create({ id: `s${i}`, modeId: null, startedAt: i })
      f.transcript.upsert(line(`s${i}`, 'me', 0, `enterprise number ${i}`))
    }
    expect(
      (await ok<{ groups: unknown[] }>('search:query', { query: 'enterprise' })).groups,
    ).toHaveLength(50)
    expect(
      (await ok<{ groups: unknown[] }>('search:query', { query: 'enterprise', limit: 5 })).groups,
    ).toHaveLength(5)
    const q = await ok<{ looksLikeQuestion: boolean; groups: unknown[] }>('search:query', {
      query: 'NEAR("*',
    })
    expect(q.groups).toEqual([])
    expect(await errorCode('search:query', { query: 'x'.repeat(501) })).toBe('invalid_payload')
  })

  it('exports all data to a zip chosen in a save dialog', async () => {
    const f = wire()
    f.sessions.create({ id: 's', modeId: null, startedAt: 1 })
    const target = join(dir, 'export.zip')
    const save = vi
      .spyOn(dialog, 'showSaveDialog')
      .mockResolvedValueOnce({ canceled: false, filePath: target })
    expect(await ok('data:exportAll')).toEqual({ path: target })
    const options = save.mock.calls[0]?.[0] as unknown as { defaultPath: string }
    expect(options.defaultPath).toMatch(/^bluely-export-\d{4}-\d{2}-\d{2}\.zip$/)
    const files = unzipSync(new Uint8Array(readFileSync(target)))
    const json = JSON.parse(strFromU8(files['bluely-export.json'] ?? new Uint8Array())) as {
      version: string
      sessions: unknown[]
    }
    expect(json.version).toBe('0.0.0-test')
    expect(json.sessions).toHaveLength(1)

    vi.spyOn(dialog, 'showSaveDialog').mockResolvedValueOnce({ canceled: true, filePath: '' })
    expect(await ok('data:exportAll')).toEqual({ path: null })
  })

  it('deletes all data on confirmation and resets a deleted custom mode', async () => {
    const f = wire()
    const now = Date.now()
    db.prepare(
      "INSERT INTO modes(id, name, is_builtin, created_at, updated_at) VALUES ('custom', 'Mine', 0, ?, ?)",
    ).run(now, now)
    ctx.settings.update({ activeModeId: 'custom', profile: { name: 'Ada' } })
    f.sessions.create({ id: 's', modeId: 'custom', startedAt: 1 })
    f.sessions.setStatus('s', 'done')
    mkdirSync(ctx.paths.screenshotsDir, { recursive: true })

    expect(await errorCode('data:deleteAll', { confirm: 'delete' })).toBe('invalid_payload')
    expect(await errorCode('data:deleteAll', {})).toBe('invalid_payload')
    f.sessions.create({ id: 'live', modeId: null, startedAt: 2 })
    expect(await errorCode('data:deleteAll', { confirm: 'DELETE' })).toBe('session_live')
    f.sessions.setStatus('live', 'done')

    await ok('data:deleteAll', { confirm: 'DELETE' })
    expect(f.sessions.list()).toEqual([])
    expect(ctx.settings.get().activeModeId).toBe('builtin-general')
    expect(ctx.settings.get().profile.name).toBe('Ada')
    expect(existsSync(ctx.paths.screenshotsDir)).toBe(false)
    expect(changes).toEqual([null])

    ctx.settings.update({ activeModeId: 'builtin-sales' })
    await ok('data:deleteAll', { confirm: 'DELETE' })
    expect(ctx.settings.get().activeModeId).toBe('builtin-sales') // built-in modes survive
  })

  it('broadcasts a refresh when retention deletes sessions later', () => {
    const f = wire()
    db.prepare(
      "INSERT INTO sessions(id, title, started_at, status, created_at) VALUES ('old', 'Old', 1, 'done', 1)",
    ).run()
    ctx.settings.update({ privacy: { retentionDays: 365 } })
    expect(f.sessions.get('old')).toBeNull()
    expect(changes).toEqual([null])
  })

  it('rejects requests from untrusted frames', async () => {
    wire()
    const fn = handlers.get('sessions:list')
    const res = (await fn?.(
      {
        senderFrame: { url: 'https://evil.example/' },
        sender: { id: 9 },
      } as unknown as IpcMainInvokeEvent,
      {},
    )) as IpcEnvelope<unknown>
    expect(res).toMatchObject({ ok: false, error: { code: 'forbidden' } })
  })
})
