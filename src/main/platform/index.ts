/**
 * Platform dispatch. Windows-specific code lives in ./win32; everything else must stay
 * cross-platform-friendly.
 */
import { app } from 'electron'
import * as win32 from './win32'

export type LoopbackAudio = 'loopback' | 'loopbackWithMute' | null

/** Command-line switches that must be applied before app 'ready'. */
export function applyEarlySwitches(): void {
  if (process.platform === 'linux') {
    // Development convenience: Chromium needs this feature for PulseAudio loopback.
    appendFeature('PulseaudioLoopbackForScreenShare')
  }
  if (process.platform === 'win32') win32.applyEarlySwitches()
}

export function onReady(): void {
  if (process.platform === 'win32') win32.onReady()
}

/** Audio option for setDisplayMediaRequestHandler. 'loopback' captures desktop audio. */
export function loopbackAudioOption(): LoopbackAudio {
  if (process.platform === 'win32' || process.platform === 'linux') return 'loopback'
  return null
}

/**
 * Whether "Launch at startup" can be turned on in this build: Windows (installed, or portable
 * started through its launcher) and macOS. Settings can hide or disable the toggle when false.
 */
export function canLaunchAtStartup(): boolean {
  if (process.platform === 'win32') return win32.canLaunchAtStartup()
  return process.platform === 'darwin'
}

/**
 * Registers (or removes) Bluely as a sign-in item; does nothing on other platforms. On Windows,
 * enabling throws when canLaunchAtStartup() is false instead of registering a temporary exe.
 */
export function setLaunchAtStartup(enabled: boolean): void {
  if (process.platform === 'win32') {
    win32.setLaunchAtStartup(enabled)
    return
  }
  if (process.platform === 'darwin') {
    app.setLoginItemSettings({ openAtLogin: enabled })
  }
}

export function launchedHidden(): boolean {
  return process.argv.includes('--hidden')
}

export function isPortableBuild(): boolean {
  return process.platform === 'win32' && win32.isPortableBuild()
}

function appendFeature(feature: string): void {
  const existing = app.commandLine.getSwitchValue('enable-features')
  const features = new Set(existing ? existing.split(',').filter(Boolean) : [])
  features.add(feature)
  app.commandLine.appendSwitch('enable-features', [...features].join(','))
}
