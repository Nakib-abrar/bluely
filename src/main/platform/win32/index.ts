import { app } from 'electron'

/**
 * Bluely's AppUserModelId (= `appId` in electron-builder.yml). It is also the value name of the
 * launch-at-startup entry in HKCU\...\Run, which build/installer.nsh deletes on uninstall.
 */
export const APP_USER_MODEL_ID = 'io.github.nakib-abrar.bluely'

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

export function setLaunchAtStartup(enabled: boolean): void {
  const exe = startupExecutable()
  if (enabled && exe === null) {
    throw new Error('Launch at startup is not available: the portable launcher path is unknown')
  }
  app.setLoginItemSettings({
    openAtLogin: enabled,
    // Disabling deletes the value by name, so the path only matters when enabling.
    path: exe ?? process.execPath,
    args: enabled ? [...STARTUP_ARGS] : [],
    // Electron's default is the AppUserModelId too, but only once onReady() has set it; naming
    // it explicitly keeps the value in step with the uninstaller (build/installer.nsh).
    name: APP_USER_MODEL_ID,
  })
}

/**
 * Makes the Run value match the launchAtStartup setting (see platform.syncLaunchAtStartup).
 * Rewrites it only when it does not already start this exe with --hidden: Electron's
 * openAtLogin compares the value named after the AppUserModelId with that command line and
 * ignores StartupApproved, so an entry the user disabled in Task Manager stays disabled.
 * When the setting is off, the value is deleted by name, wherever it points.
 */
export function syncLaunchAtStartup(wanted: boolean): void {
  if (!wanted) {
    setLaunchAtStartup(false)
    return
  }
  const exe = startupExecutable()
  // A portable build started without its launcher has nothing to register that survives.
  if (exe === null) return
  if (app.getLoginItemSettings({ path: exe, args: [...STARTUP_ARGS] }).openAtLogin) return
  setLaunchAtStartup(true)
}

/** electron-builder's portable launcher sets this variable for the extracted app. */
export function isPortableBuild(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env['PORTABLE_EXECUTABLE_DIR']
}
