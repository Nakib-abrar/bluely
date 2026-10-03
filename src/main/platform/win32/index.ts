import { app } from 'electron'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { access } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Bluely's AppUserModelId (= `appId` in electron-builder.yml). It is also the value name of the
 * launch-at-startup entry in HKCU\...\Run, which build/installer.nsh deletes on uninstall.
 */
export const APP_USER_MODEL_ID = 'io.github.nakib-abrar.bluely'

/**
 * Which exe the Run value was last written for, in Bluely's data folder. Every copy of Bluely
 * (installed, portable, all users) shares %APPDATA%\Bluely and the Run value name, so this is
 * how one copy recognizes an entry that belongs to another copy (see syncLaunchAtStartup).
 */
export const STARTUP_RECORD_FILE = 'launch-at-startup.json'

export function applyEarlySwitches(): void {
  // Nothing required today: desktop loopback uses audio: 'loopback' without extra switches.
  // Verified for the pinned Electron in Windows CI (virtual sound card), not yet on a physical
  // Windows 10/11 PC; see docs/VERIFY_LOOPBACK.md.
}

export function onReady(): void {
  // Groups taskbar entries / notifications under Bluely instead of electron.exe.
  app.setAppUserModelId(APP_USER_MODEL_ID)
}

/**
 * The exe Windows should start at sign-in, or null when there is none that survives a restart.
 * The portable build runs from a copy that its launcher extracts to %TEMP% and deletes when the
 * app exits, so process.execPath must not be registered there: register the launcher instead
 * (PORTABLE_EXECUTABLE_FILE), which forwards its arguments (--hidden) to the app.
 */
export function startupExecutable(env: NodeJS.ProcessEnv = process.env): string | null {
  if (!isPortableBuild(env)) return process.execPath
  return env['PORTABLE_EXECUTABLE_FILE'] || null
}

/** False only for a portable build whose launcher path is unknown (see startupExecutable). */
export function canLaunchAtStartup(env: NodeJS.ProcessEnv = process.env): boolean {
  return startupExecutable(env) !== null
}

/** Started minimized to the taskbar; the tray icon is always present. */
const STARTUP_ARGS = ['--hidden']

/** Turns launch at startup on or off for this copy of Bluely (the Settings toggle). */
export function setLaunchAtStartup(enabled: boolean): void {
  if (!enabled) {
    unregister()
    return
  }
  const exe = startupExecutable()
  if (exe === null) {
    throw new Error('Launch at startup is not available: the portable launcher path is unknown')
  }
  register(exe)
}

/**
 * Makes the Run value match the launchAtStartup setting; called once per start (see
 * platform.syncLaunchAtStartup). `wanted` is read again after any wait, so a change the user
 * makes meanwhile (which setLaunchAtStartup applies at once) is never undone.
 *
 * - An entry that already starts this exe with --hidden is left alone, so a Task Manager
 *   "Disabled" stays (Electron's openAtLogin compares the value named after the AppUserModelId
 *   with that command line and ignores StartupApproved). When the setting is off it is deleted.
 * - An entry that starts the exe recorded in STARTUP_RECORD_FILE, a different copy of Bluely,
 *   belongs to that copy: it is left alone while that exe exists, whatever this copy's setting,
 *   so starting a portable copy, release\win-unpacked or the packaged E2E test never takes over
 *   or deletes the installed app's entry. Once that exe is gone (uninstalled into another
 *   folder, a moved portable exe) the entry is repointed here, keeping a "Disabled" choice, or
 *   deleted when the setting is off.
 * - A missing entry is written when the setting is on (the uninstaller deleted it, the setting
 *   survived). An entry for an exe nobody recorded (written before the record existed) is
 *   repointed when the setting is on and otherwise left alone.
 */
export async function syncLaunchAtStartup(wanted: () => boolean): Promise<void> {
  const want = wanted()
  const exe = startupExecutable()
  if (exe !== null && startsAtLogin(exe)) {
    if (!want) unregister()
    else if (readRecord() !== exe) writeRecord(exe)
    return
  }
  const owner = readRecord()
  const ownedElsewhere = owner !== null && !samePath(owner, exe) && startsAtLogin(owner)
  if (!ownedElsewhere) {
    // A portable build started without its launcher has nothing to register that survives.
    if (want && exe !== null) register(exe)
    return
  }
  if (await exists(owner)) return
  // Only act on what is still true after the wait.
  if (wanted() !== want || !startsAtLogin(owner)) return
  if (!want) unregister()
  else if (exe !== null) register(exe, { enabled: approvedAtLogin(owner) })
}

/** electron-builder's portable launcher sets this variable for the extracted app. */
export function isPortableBuild(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env['PORTABLE_EXECUTABLE_DIR']
}

function register(exe: string, opts: { enabled?: boolean } = {}): void {
  app.setLoginItemSettings({
    openAtLogin: true,
    path: exe,
    args: [...STARTUP_ARGS],
    // Electron's default is the AppUserModelId too, but only once onReady() has set it; naming
    // it explicitly keeps the value in step with the uninstaller (build/installer.nsh).
    name: APP_USER_MODEL_ID,
    // Electron's default (true) deletes the StartupApproved value, i.e. a Task Manager choice.
    ...(opts.enabled === false ? { enabled: false } : {}),
  })
  writeRecord(exe)
}

function unregister(): void {
  // Deletes the value (and its StartupApproved value) by name, wherever it points.
  app.setLoginItemSettings({
    openAtLogin: false,
    path: startupExecutable() ?? process.execPath,
    args: [],
    name: APP_USER_MODEL_ID,
  })
  writeRecord(null)
}

/** Whether the Run value is exactly `"<exe>" --hidden`, i.e. what register(exe) writes. */
function startsAtLogin(exe: string): boolean {
  return app.getLoginItemSettings({ path: exe, args: [...STARTUP_ARGS] }).openAtLogin
}

/** False when the user disabled the entry that starts `exe` in Task Manager. */
function approvedAtLogin(exe: string): boolean {
  const { launchItems = [] } = app.getLoginItemSettings({ path: exe, args: [...STARTUP_ARGS] })
  const item = launchItems.find((i) => i.name === APP_USER_MODEL_ID && i.scope === 'user')
  return item?.enabled ?? true
}

/** Windows paths compare case-insensitively. */
function samePath(a: string, b: string | null): boolean {
  return b !== null && a.toLowerCase() === b.toLowerCase()
}

/** Asynchronous, so an exe on an unreachable network share cannot stall startup. */
async function exists(file: string): Promise<boolean> {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

function recordFile(): string {
  return join(app.getPath('userData'), STARTUP_RECORD_FILE)
}

function readRecord(): string | null {
  try {
    const { path } = JSON.parse(readFileSync(recordFile(), 'utf8')) as { path?: unknown }
    return typeof path === 'string' && path ? path : null
  } catch {
    return null
  }
}

/**
 * Best effort: the record only lets the next start recognize this copy's entry. Without it, a
 * copy that wants launch at startup repoints an entry it cannot attribute (the old behaviour).
 */
function writeRecord(exe: string | null): void {
  try {
    if (exe === null) rmSync(recordFile(), { force: true })
    else writeFileSync(recordFile(), `${JSON.stringify({ path: exe })}\n`)
  } catch {
    // Read-only or missing data folder: nothing else depends on the record.
  }
}
