import { autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater'
import { updater as updaterMessages } from '@shared/i18n/en/updater'
import { RELEASES_URL } from '@shared/constants'
import type { UpdateStatus } from '@shared/types'
import type { CoreContext } from './context'
import { AppError } from './errors'
import type { EventBus } from './ipc/events'
import { handle } from './ipc/registry'
import type { Logger } from './log'

/** First background check after app start. Late enough not to compete with startup work. */
export const AUTO_CHECK_FIRST_DELAY_MS = 10_000
/** Minimum time between background checks. */
export const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
/**
 * How often the background timer wakes up to see whether a check is due. Polling against the
 * wall clock (instead of one 6 h setInterval) keeps the schedule right after sleep/hibernate.
 */
export const AUTO_CHECK_POLL_MS = 15 * 60 * 1000

/**
 * English status texts shown in Settings › General.
 * TODO(i18n): move to an `updater` i18n namespace once the contract has one (see packaging report).
 */
/** Source of truth: src/shared/i18n/en/updater.ts. */
export const UPDATER_MESSAGES = updaterMessages

export interface UpdaterOptions {
  events: Pick<EventBus, 'broadcast'>
  log: Logger
  /** app.isPackaged. Unpackaged (dev/test) builds never contact GitHub. */
  isPackaged: boolean
  /** electron-builder portable target: electron-updater can only update NSIS installs. */
  isPortable: boolean
  /** Clock used for auto-check gating (injectable for tests). */
  now?: () => number
}

const BUSY_STATES: ReadonlySet<UpdateStatus['state']> = new Set([
  'checking',
  'downloading',
  'downloaded',
])

/**
 * Wraps electron-updater's autoUpdater for GitHub Releases (NSIS builds only).
 * Every state change is broadcast as 'updater:status'. Updates are never downloaded or
 * installed without the user asking: autoDownload is off; a downloaded update installs on
 * "Restart to update" or, failing that, when Bluely quits.
 */
export class Updater {
  private readonly events: Pick<EventBus, 'broadcast'>
  private readonly log: Logger
  private readonly isPackaged: boolean
  private readonly isPortable: boolean
  private readonly now: () => number
  private current: UpdateStatus
  /** Version offered by the last successful check; kept through download errors for retries. */
  private availableVersion: string | null = null
  private inFlightCheck: Promise<UpdateStatus> | null = null
  private lastCheckAt: number | null = null
  private firstTimer: ReturnType<typeof setTimeout> | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private listenersAttached = false

  constructor(opts: UpdaterOptions) {
    this.events = opts.events
    this.log = opts.log
    this.isPackaged = opts.isPackaged
    this.isPortable = opts.isPortable
    this.now = opts.now ?? Date.now
    this.current = this.unsupportedStatus() ?? {
      state: 'idle',
      version: null,
      progress: null,
      error: null,
      releaseUrl: null,
    }
  }

  /** True for installed (NSIS) builds, the only ones electron-updater can update. */
  get supported(): boolean {
    return this.isPackaged && !this.isPortable
  }

  status(): UpdateStatus {
    return { ...this.current }
  }

  /**
   * Checks GitHub Releases for a newer version. Never rejects: failures end in state 'error'.
   * Concurrent calls share one request. A pending or downloaded update is not re-checked so the
   * "Restart to update" state is never lost.
   */
  check(): Promise<UpdateStatus> {
    const unsupported = this.unsupportedStatus()
    if (unsupported) {
      this.set(unsupported)
      return Promise.resolve(this.status())
    }
    if (this.current.state === 'downloading' || this.current.state === 'downloaded') {
      return Promise.resolve(this.status())
    }
    if (this.inFlightCheck) return this.inFlightCheck
    this.lastCheckAt = this.now()
    this.inFlightCheck = this.runCheck().finally(() => {
      this.inFlightCheck = null
    })
    return this.inFlightCheck
  }

  /**
   * Starts downloading the update found by the last check and returns once it has started;
   * progress and completion arrive as 'updater:status' events.
   */
  async download(): Promise<void> {
    this.assertSupported()
    if (this.current.state === 'downloading' || this.current.state === 'downloaded') return
    const version = this.availableVersion
    if (!version) throw new AppError('no_update', UPDATER_MESSAGES.noUpdate)
    const updater = this.updater()
    this.set({
      state: 'downloading',
      version,
      progress: 0,
      error: null,
      releaseUrl: releaseTagUrl(version),
    })
    this.log.info(`Downloading update ${version}`)
    updater.downloadUpdate().then(
      () => {
        // 'update-downloaded' normally arrives first; this covers a missing event.
        if (this.current.state === 'downloading') this.markDownloaded(version)
      },
      (err: unknown) => this.fail(err),
    )
  }

  /** Quits Bluely and runs the downloaded installer, which relaunches the app when done. */
  install(): void {
    this.assertSupported()
    if (this.current.state !== 'downloaded') {
      throw new AppError('no_update', UPDATER_MESSAGES.notDownloaded)
    }
    this.log.info(`Installing update ${this.current.version ?? '?'}`)
    // isSilent=false shows the installer's progress; isForceRunAfter=true restarts Bluely.
    this.updater().quitAndInstall(false, true)
  }

  /**
   * Schedules background checks: the first ~10 s after start, then every 6 h. Only installed
   * NSIS builds check; returns false (and schedules nothing) for dev and portable builds.
   */
  startAutoCheck(): boolean {
    if (!this.supported) return false
    if (this.firstTimer || this.pollTimer) return true
    this.firstTimer = setTimeout(() => {
      this.firstTimer = null
      void this.autoCheck()
    }, AUTO_CHECK_FIRST_DELAY_MS)
    this.pollTimer = setInterval(() => void this.autoCheck(), AUTO_CHECK_POLL_MS)
    // Background checks must never keep the process alive.
    this.firstTimer.unref?.()
    this.pollTimer.unref?.()
    return true
  }

  /** Stops background checks (on shutdown). */
  dispose(): void {
    if (this.firstTimer) clearTimeout(this.firstTimer)
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.firstTimer = null
    this.pollTimer = null
  }

  private async autoCheck(): Promise<void> {
    if (BUSY_STATES.has(this.current.state)) return
    // A manual check also counts, so the background check never repeats one the user just did.
    if (this.lastCheckAt !== null && this.now() - this.lastCheckAt < AUTO_CHECK_INTERVAL_MS) return
    this.log.debug('Background update check')
    await this.check()
  }

  private async runCheck(): Promise<UpdateStatus> {
    this.markChecking()
    try {
      const result = await this.updater().checkForUpdates()
      if (!result) {
        // electron-updater returns null when it considers the app unpackaged.
        this.set(this.unsupportedFor('unpackaged'))
      } else if (this.current.state === 'checking') {
        // The result is authoritative if the events did not settle the state.
        if (result.isUpdateAvailable) this.markAvailable(result.updateInfo)
        else this.markNotAvailable(result.updateInfo)
      }
    } catch (err) {
      this.fail(err)
    }
    return this.status()
  }

  /** Lazily configures electron-updater so dev/portable builds never instantiate it. */
  private updater(): typeof autoUpdater {
    const updater = autoUpdater
    if (this.listenersAttached) return updater
    this.listenersAttached = true
    updater.autoDownload = false
    updater.autoInstallOnAppQuit = true
    updater.allowPrerelease = false
    updater.logger = {
      info: (m?: unknown) => this.log.info(describe(m)),
      warn: (m?: unknown) => this.log.warn(describe(m)),
      error: (m?: unknown) => this.log.error(describe(m)),
      debug: (m: string) => this.log.debug(m),
    }
    updater.on('checking-for-update', () => this.markChecking())
    updater.on('update-available', (info: UpdateInfo) => this.markAvailable(info))
    updater.on('update-not-available', (info: UpdateInfo) => this.markNotAvailable(info))
    updater.on('download-progress', (p: ProgressInfo) => {
      const version = this.availableVersion ?? this.current.version
      this.set({
        state: 'downloading',
        version,
        progress: clampPercent(p.percent),
        error: null,
        releaseUrl: version ? releaseTagUrl(version) : null,
      })
    })
    updater.on('update-downloaded', (info: UpdateInfo) => this.markDownloaded(info.version))
    updater.on('update-cancelled', () => {
      if (this.availableVersion) this.markAvailable({ version: this.availableVersion })
    })
    updater.on('error', (err: unknown) => this.fail(err))
    return updater
  }

  private markChecking(): void {
    this.set({
      state: 'checking',
      version: this.availableVersion,
      progress: null,
      error: null,
      releaseUrl: null,
    })
  }

  private markAvailable(info: Pick<UpdateInfo, 'version'>): void {
    this.availableVersion = info.version
    this.set({
      state: 'available',
      version: info.version,
      progress: null,
      error: null,
      releaseUrl: releaseTagUrl(info.version),
    })
  }

  private markNotAvailable(info: Pick<UpdateInfo, 'version'>): void {
    this.availableVersion = null
    // `version` is the newest version GitHub reports (normally the running one).
    this.set({
      state: 'not-available',
      version: info.version,
      progress: null,
      error: null,
      releaseUrl: null,
    })
  }

  private markDownloaded(version: string): void {
    this.availableVersion = version
    this.set({
      state: 'downloaded',
      version,
      progress: 100,
      error: null,
      releaseUrl: releaseTagUrl(version),
    })
  }

  private fail(err: unknown): void {
    this.log.warn('Update error', err instanceof Error ? err : describe(err))
    this.set({
      state: 'error',
      version: this.availableVersion,
      progress: null,
      error: describeUpdateError(err),
      // Manual download is always possible from the Releases page.
      releaseUrl: RELEASES_URL,
    })
  }

  private assertSupported(): void {
    const unsupported = this.unsupportedStatus()
    if (unsupported) throw new AppError('updates_unsupported', unsupported.error ?? '')
  }

  private unsupportedStatus(): UpdateStatus | null {
    if (!this.isPackaged) return this.unsupportedFor('unpackaged')
    if (this.isPortable) return this.unsupportedFor('portable')
    return null
  }

  private unsupportedFor(kind: 'unpackaged' | 'portable'): UpdateStatus {
    return {
      state: 'unsupported',
      version: null,
      progress: null,
      error: UPDATER_MESSAGES[kind],
      releaseUrl: kind === 'portable' ? RELEASES_URL : null,
    }
  }

  private set(next: UpdateStatus): void {
    const prev = this.current
    if (
      prev.state === next.state &&
      prev.version === next.version &&
      prev.progress === next.progress &&
      prev.error === next.error &&
      prev.releaseUrl === next.releaseUrl
    ) {
      return
    }
    this.current = next
    this.events.broadcast('updater:status', this.status())
  }
}

/** Registers the updater IPC handlers and starts background checks (installed builds only). */
export function wireUpdater(ctx: CoreContext, opts: { isPortable: boolean }): Updater {
  const updater = new Updater({
    events: ctx.events,
    log: ctx.log.child('updater'),
    isPackaged: ctx.env.isPackaged,
    isPortable: opts.isPortable,
  })
  handle('updater:check', () => updater.check())
  handle('updater:download', () => updater.download())
  handle('updater:install', () => updater.install())
  handle('updater:getStatus', () => updater.status())
  updater.startAutoCheck()
  return updater
}

/** Maps electron-updater / network errors to a short message for Settings › General. */
export function describeUpdateError(err: unknown): string {
  const raw = describe(err)
  if (/net::ERR_|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH/.test(raw)) {
    return UPDATER_MESSAGES.offline
  }
  if (/sha512 checksum mismatch/i.test(raw)) return UPDATER_MESSAGES.integrity
  if (/\b(403|429)\b|rate limit/i.test(raw)) return UPDATER_MESSAGES.rateLimited
  if (
    /\b404\b|Cannot find latest\.yml|No published versions|Unable to find latest version/i.test(raw)
  ) {
    return UPDATER_MESSAGES.noRelease
  }
  const firstLine = (raw.split('\n')[0] ?? '').trim().slice(0, 200)
  return UPDATER_MESSAGES.failed.replace('{reason}', firstLine || 'unknown error')
}

function describe(value: unknown): string {
  if (value instanceof Error) return value.message
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function releaseTagUrl(version: string): string {
  return `${RELEASES_URL}/tag/v${version}`
}

function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0
  return Math.round(Math.min(100, Math.max(0, percent)) * 10) / 10
}
