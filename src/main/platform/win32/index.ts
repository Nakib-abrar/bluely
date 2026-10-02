import { app } from 'electron'

export const APP_USER_MODEL_ID = 'io.github.nakib-abrar.bluely'

export function applyEarlySwitches(): void {
  // Nothing required today: Windows desktop loopback works with audio: 'loopback'.
}

export function onReady(): void {
  // Groups taskbar entries / notifications under Bluely instead of electron.exe.
  app.setAppUserModelId(APP_USER_MODEL_ID)
}

export function setLaunchAtStartup(enabled: boolean): void {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    // Started minimized to the taskbar; the tray icon is always present.
    args: enabled ? ['--hidden'] : [],
  })
}

/** electron-builder's portable target sets this variable for the extracted app. */
export function isPortableBuild(): boolean {
  return !!process.env['PORTABLE_EXECUTABLE_DIR']
}
