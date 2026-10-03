import type { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { UpdateStatus } from '@shared/types'
import { RELEASES_URL } from '@shared/constants'

/** Fake of electron-updater's autoUpdater (an EventEmitter with the methods Bluely uses). */
interface FakeAutoUpdater extends EventEmitter {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowPrerelease: boolean
  logger: unknown
  checkForUpdates: Mock<() => Promise<unknown>>
  downloadUpdate: Mock<() => Promise<string[]>>
  quitAndInstall: Mock<(isSilent?: boolean, isForceRunAfter?: boolean) => void>
}

vi.mock('electron-updater', async () => {
  const { EventEmitter: Emitter } = await import('node:events')
  const fake = Object.assign(new Emitter(), {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    allowPrerelease: true,
    logger: null as unknown,
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
  })
  return { autoUpdater: fake }
})

const handlers = vi.hoisted(() => new Map<string, (req: unknown) => unknown>())
vi.mock('@main/ipc/registry', () => ({
  handle: (channel: string, fn: (req: unknown) => unknown) => {
    handlers.set(channel, fn)
  },
}))

import { autoUpdater } from 'electron-updater'
import type { CoreContext } from '@main/context'
import type { Logger } from '@main/log'
import { AppError } from '@main/errors'
import {
  AUTO_CHECK_FIRST_DELAY_MS,
  AUTO_CHECK_INTERVAL_MS,
  AUTO_CHECK_POLL_MS,
  UPDATER_MESSAGES,
  Updater,
  describeUpdateError,
  wireUpdater,
} from '@main/updater'

const fake = autoUpdater as unknown as FakeAutoUpdater

function silentLog(): Logger {
  const log: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => log,
    setDebug: () => undefined,
  }
  return log
}

function makeUpdater(
  opts: { isPackaged?: boolean; isPortable?: boolean; now?: () => number } = {},
) {
  const broadcasts: UpdateStatus[] = []
  const events = {
    broadcast: vi.fn((event: string, payload: UpdateStatus) => {
      expect(event).toBe('updater:status')
      broadcasts.push(payload)
    }),
  }
  const updater = new Updater({
    events: events as unknown as ConstructorParameters<typeof Updater>[0]['events'],
    log: silentLog(),
    isPackaged: opts.isPackaged ?? true,
    isPortable: opts.isPortable ?? false,
    ...(opts.now ? { now: opts.now } : {}),
  })
  return { updater, broadcasts, states: () => broadcasts.map((b) => b.state) }
}

/** Makes checkForUpdates emit the events electron-updater emits, then resolve. */
function respondWith(version: string | null, currentVersion = '0.1.0') {
  fake.checkForUpdates.mockImplementation(async () => {
    fake.emit('checking-for-update')
    await Promise.resolve()
    const info = { version: version ?? currentVersion, files: [], path: '', sha512: '' }
    if (version) fake.emit('update-available', info)
    else fake.emit('update-not-available', info)
    return { isUpdateAvailable: !!version, updateInfo: info, versionInfo: info }
  })
}

const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  fake.removeAllListeners()
  fake.checkForUpdates.mockReset()
  fake.downloadUpdate.mockReset()
  fake.quitAndInstall.mockReset()
  fake.autoDownload = true
  fake.autoInstallOnAppQuit = false
  fake.allowPrerelease = true
  fake.logger = null
  handlers.clear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Updater: installed (NSIS) build', () => {
  it('configures electron-updater for manual download on first use', async () => {
    const { updater } = makeUpdater()
    respondWith(null)
    await updater.check()
    expect(fake.autoDownload).toBe(false)
    expect(fake.autoInstallOnAppQuit).toBe(true)
    expect(fake.allowPrerelease).toBe(false)
    expect(fake.logger).not.toBeNull()
  })

  it('available → downloading (progress) → downloaded → install', async () => {
    const { updater, broadcasts, states } = makeUpdater()
    expect(updater.status().state).toBe('idle')
    respondWith('0.2.0')

    const afterCheck = await updater.check()
    expect(afterCheck).toEqual({
      state: 'available',
      version: '0.2.0',
      progress: null,
      error: null,
      releaseUrl: `${RELEASES_URL}/tag/v0.2.0`,
    })
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(1)

    let finishDownload: (files: string[]) => void = () => undefined
    fake.downloadUpdate.mockImplementation(
      () =>
        new Promise<string[]>((resolve) => {
          finishDownload = resolve
        }),
    )
    await updater.download()
    expect(fake.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(updater.status()).toMatchObject({ state: 'downloading', progress: 0, version: '0.2.0' })

    fake.emit('download-progress', {
      percent: 12.345,
      bytesPerSecond: 1,
      total: 100,
      transferred: 12,
    })
    expect(updater.status().progress).toBe(12.3)
    fake.emit('download-progress', {
      percent: 87.66,
      bytesPerSecond: 1,
      total: 100,
      transferred: 88,
    })
    expect(updater.status().progress).toBe(87.7)
    // Same rounded value: no extra broadcast.
    const before = broadcasts.length
    fake.emit('download-progress', {
      percent: 87.71,
      bytesPerSecond: 1,
      total: 100,
      transferred: 88,
    })
    expect(broadcasts.length).toBe(before)

    fake.emit('update-downloaded', { version: '0.2.0', downloadedFile: 'x.exe', files: [] })
    finishDownload(['x.exe'])
    await flush()
    expect(updater.status()).toMatchObject({ state: 'downloaded', progress: 100, version: '0.2.0' })
    expect(states()).toEqual([
      'checking',
      'available',
      'downloading',
      'downloading',
      'downloading',
      'downloaded',
    ])

    // A check while an update waits for install keeps the downloaded state.
    await updater.check()
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(updater.status().state).toBe('downloaded')

    updater.install()
    expect(fake.quitAndInstall).toHaveBeenCalledWith(false, true)
  })

  it('marks downloaded from the download promise if the event never arrives', async () => {
    const { updater } = makeUpdater()
    respondWith('0.3.0')
    await updater.check()
    fake.downloadUpdate.mockResolvedValue(['x.exe'])
    await updater.download()
    await flush()
    expect(updater.status()).toMatchObject({ state: 'downloaded', version: '0.3.0', progress: 100 })
  })

  it('not-available reports the latest version and clears any error', async () => {
    const { updater, states } = makeUpdater()
    respondWith(null, '0.1.0')
    const s = await updater.check()
    expect(s).toEqual({
      state: 'not-available',
      version: '0.1.0',
      progress: null,
      error: null,
      releaseUrl: null,
    })
    expect(states()).toEqual(['checking', 'not-available'])
  })

  it('derives the state from the result when no events were emitted', async () => {
    const { updater } = makeUpdater()
    const info = { version: '0.4.0', files: [], path: '', sha512: '' }
    fake.checkForUpdates.mockResolvedValue({ isUpdateAvailable: true, updateInfo: info })
    expect((await updater.check()).state).toBe('available')
    fake.checkForUpdates.mockResolvedValue({ isUpdateAvailable: false, updateInfo: info })
    expect((await updater.check()).state).toBe('not-available')
  })

  it('a failed check ends in error (event + rejection) and never rejects', async () => {
    const { updater, states } = makeUpdater()
    fake.checkForUpdates.mockImplementation(async () => {
      const err = new Error('net::ERR_INTERNET_DISCONNECTED')
      fake.emit('error', err)
      throw err
    })
    const s = await updater.check()
    expect(s).toEqual({
      state: 'error',
      version: null,
      progress: null,
      error: UPDATER_MESSAGES.offline,
      releaseUrl: RELEASES_URL,
    })
    // The duplicate error (event + rejection) is broadcast once.
    expect(states()).toEqual(['checking', 'error'])
  })

  it('a failed download keeps the version so the user can retry', async () => {
    const { updater } = makeUpdater()
    respondWith('0.2.0')
    await updater.check()
    fake.downloadUpdate.mockRejectedValueOnce(new Error('sha512 checksum mismatch, expected abc'))
    await updater.download()
    await flush()
    expect(updater.status()).toMatchObject({
      state: 'error',
      version: '0.2.0',
      error: UPDATER_MESSAGES.integrity,
    })
    fake.downloadUpdate.mockResolvedValueOnce(['x.exe'])
    await updater.download()
    await flush()
    expect(updater.status().state).toBe('downloaded')
    expect(fake.downloadUpdate).toHaveBeenCalledTimes(2)
  })

  it('shares one in-flight check between concurrent callers', async () => {
    const { updater } = makeUpdater()
    respondWith('0.2.0')
    const [a, b] = await Promise.all([updater.check(), updater.check()])
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(a).toEqual(b)
  })

  it('refuses to download or install without an update', async () => {
    const { updater } = makeUpdater()
    await expect(updater.download()).rejects.toMatchObject({ code: 'no_update' })
    expect(() => updater.install()).toThrow(AppError)
    respondWith(null)
    await updater.check()
    await expect(updater.download()).rejects.toMatchObject({ code: 'no_update' })
    expect(fake.downloadUpdate).not.toHaveBeenCalled()
    expect(fake.quitAndInstall).not.toHaveBeenCalled()
  })

  it('returns to available when a download is cancelled', async () => {
    const { updater } = makeUpdater()
    respondWith('0.2.0')
    await updater.check()
    fake.downloadUpdate.mockReturnValue(new Promise<string[]>(() => undefined))
    await updater.download()
    fake.emit('update-cancelled', { version: '0.2.0' })
    expect(updater.status().state).toBe('available')
  })
})

describe('Updater: unsupported builds', () => {
  it('unpackaged builds never touch electron-updater', async () => {
    const { updater, broadcasts } = makeUpdater({ isPackaged: false })
    expect(updater.supported).toBe(false)
    expect(updater.status()).toEqual({
      state: 'unsupported',
      version: null,
      progress: null,
      error: 'Updates are checked in installed builds.',
      releaseUrl: null,
    })
    const s = await updater.check()
    expect(s.state).toBe('unsupported')
    expect(s.error).toBe(UPDATER_MESSAGES.unpackaged)
    expect(fake.checkForUpdates).not.toHaveBeenCalled()
    expect(fake.logger).toBeNull()
    expect(broadcasts).toEqual([])
    await expect(updater.download()).rejects.toMatchObject({ code: 'updates_unsupported' })
    expect(() => updater.install()).toThrow(AppError)
  })

  it('portable builds point to the Releases page', async () => {
    const { updater } = makeUpdater({ isPortable: true })
    const s = await updater.check()
    expect(s).toEqual({
      state: 'unsupported',
      version: null,
      progress: null,
      error: "Portable builds don't auto-update; download the latest release.",
      releaseUrl: RELEASES_URL,
    })
    expect(fake.checkForUpdates).not.toHaveBeenCalled()
    await expect(updater.download()).rejects.toBeInstanceOf(AppError)
  })
})

describe('Updater: background checks', () => {
  it('checks ~10 s after start, then every 6 h', async () => {
    vi.useFakeTimers()
    const { updater } = makeUpdater()
    respondWith(null)
    expect(updater.startAutoCheck()).toBe(true)
    expect(updater.startAutoCheck()).toBe(true) // idempotent

    await vi.advanceTimersByTimeAsync(AUTO_CHECK_FIRST_DELAY_MS - 1)
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(1)

    // Polls in between do not check again before 6 h have passed.
    await vi.advanceTimersByTimeAsync(AUTO_CHECK_INTERVAL_MS - AUTO_CHECK_POLL_MS)
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2 * AUTO_CHECK_POLL_MS)
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(AUTO_CHECK_INTERVAL_MS + AUTO_CHECK_POLL_MS)
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(3)

    updater.dispose()
    await vi.advanceTimersByTimeAsync(3 * AUTO_CHECK_INTERVAL_MS)
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(3)
  })

  it('a manual check postpones the next background check (injected clock)', async () => {
    vi.useFakeTimers()
    let clock = 1_000_000
    const { updater } = makeUpdater({ now: () => clock })
    respondWith(null)
    updater.startAutoCheck()

    // The user checks manually right away; the 10 s auto check is then skipped.
    await updater.check()
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(AUTO_CHECK_FIRST_DELAY_MS)
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(1)

    // Wall clock jumps (e.g. after sleep): the next poll checks immediately.
    clock += AUTO_CHECK_INTERVAL_MS
    await vi.advanceTimersByTimeAsync(AUTO_CHECK_POLL_MS)
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(2)
    updater.dispose()
  })

  it('does not re-check while an update is downloading or downloaded', async () => {
    vi.useFakeTimers()
    const { updater } = makeUpdater()
    respondWith('0.2.0')
    updater.startAutoCheck()
    await vi.advanceTimersByTimeAsync(AUTO_CHECK_FIRST_DELAY_MS)
    expect(updater.status().state).toBe('available')
    fake.downloadUpdate.mockReturnValue(new Promise<string[]>(() => undefined))
    await updater.download()
    await vi.advanceTimersByTimeAsync(2 * AUTO_CHECK_INTERVAL_MS)
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(updater.status().state).toBe('downloading')
    updater.dispose()
  })

  it.each([
    { name: 'unpackaged', isPackaged: false, isPortable: false },
    { name: 'portable', isPackaged: true, isPortable: true },
  ])('never checks in the background for $name builds', async ({ isPackaged, isPortable }) => {
    vi.useFakeTimers()
    const { updater, broadcasts } = makeUpdater({ isPackaged, isPortable })
    expect(updater.startAutoCheck()).toBe(false)
    await vi.advanceTimersByTimeAsync(2 * AUTO_CHECK_INTERVAL_MS)
    expect(fake.checkForUpdates).not.toHaveBeenCalled()
    expect(broadcasts).toEqual([])
  })
})

describe('describeUpdateError', () => {
  it('maps common failures to short messages', () => {
    expect(describeUpdateError(new Error('getaddrinfo ENOTFOUND github.com'))).toBe(
      UPDATER_MESSAGES.offline,
    )
    expect(describeUpdateError(new Error('HttpError: 404 Not Found\n "method: GET url: …"'))).toBe(
      UPDATER_MESSAGES.noRelease,
    )
    expect(describeUpdateError(new Error('Cannot find latest.yml in the latest release'))).toBe(
      UPDATER_MESSAGES.noRelease,
    )
    expect(describeUpdateError(new Error('HttpError: 403 Forbidden rate limit exceeded'))).toBe(
      UPDATER_MESSAGES.rateLimited,
    )
    expect(describeUpdateError(new Error('Something odd\nstack line'))).toBe(
      'Update failed: Something odd',
    )
    expect(describeUpdateError('plain string')).toBe('Update failed: plain string')
  })
})

describe('wireUpdater', () => {
  function ctx(isPackaged: boolean): CoreContext {
    return {
      env: { isPackaged },
      log: silentLog(),
      events: { broadcast: vi.fn() },
    } as unknown as CoreContext
  }

  it('registers the four updater channels', async () => {
    const updater = wireUpdater(ctx(false), { isPortable: false })
    expect([...handlers.keys()].sort()).toEqual([
      'updater:check',
      'updater:download',
      'updater:getStatus',
      'updater:install',
    ])
    const status = handlers.get('updater:getStatus')?.(undefined)
    expect(status).toEqual(updater.status())
    const checked = (await handlers.get('updater:check')?.(undefined)) as UpdateStatus
    expect(checked.state).toBe('unsupported')
    updater.dispose()
  })

  it('starts background checks only for installed builds', async () => {
    vi.useFakeTimers()
    respondWith(null)
    const installed = wireUpdater(ctx(true), { isPortable: false })
    await vi.advanceTimersByTimeAsync(AUTO_CHECK_FIRST_DELAY_MS)
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(1)
    installed.dispose()

    handlers.clear()
    fake.checkForUpdates.mockClear()
    const portable = wireUpdater(ctx(true), { isPortable: true })
    await vi.advanceTimersByTimeAsync(AUTO_CHECK_INTERVAL_MS)
    expect(fake.checkForUpdates).not.toHaveBeenCalled()
    portable.dispose()
  })

  it('refuses "Restart to update" while a call is live (installing quits Bluely)', () => {
    let live = true
    const updater = wireUpdater(ctx(false), { isPortable: false, isSessionLive: () => live })
    const install = handlers.get('updater:install') as () => unknown
    let thrown: unknown
    try {
      install()
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(AppError)
    expect((thrown as AppError).code).toBe('session_live')
    expect(fake.quitAndInstall).not.toHaveBeenCalled()
    // Not live: falls through to the normal checks (unsupported in an unpackaged build).
    live = false
    expect(() => install()).toThrow(AppError)
    expect(() => install()).not.toThrow(/Stop the call/)
    updater.dispose()
  })
})
