import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CoreContext } from '@main/context'

interface LoginItemSettings {
  openAtLogin?: boolean
  path?: string
  args?: string[]
  name?: string
}

const electron = vi.hoisted(() => ({
  setLoginItemSettings: vi.fn(),
  getLoginItemSettings: vi.fn(),
  setAppUserModelId: vi.fn(),
  isPackaged: true,
  /** HKCU\...\CurrentVersion\Run as Electron writes and reads it: value name -> command line. */
  runKey: new Map<string, string>(),
}))

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return electron.isPackaged
    },
    setLoginItemSettings: electron.setLoginItemSettings,
    getLoginItemSettings: electron.getLoginItemSettings,
    setAppUserModelId: electron.setAppUserModelId,
    commandLine: { getSwitchValue: () => '', appendSwitch: () => undefined },
  },
  clipboard: {},
  shell: {},
}))

const handlers = vi.hoisted(() => new Map<string, unknown>())
vi.mock('@main/ipc/registry', () => ({
  handle: (channel: string, fn: unknown) => handlers.set(channel, fn),
}))
vi.mock('@main/windows/security', () => ({ openExternalSafe: vi.fn() }))

import * as platform from '@main/platform'
import * as win32 from '@main/platform/win32'
import { registerCoreHandlers } from '@main/ipc/handlers/core'

const ROOT = join(__dirname, '..', '..', '..')
/** Where electron-builder's portable launcher extracts the app (deleted when it exits). */
const TEMP_EXE = 'C:\\Users\\nadia\\AppData\\Local\\Temp\\2fQx7\\Bluely.exe'
const PORTABLE_EXE = 'D:\\Tools\\Bluely-0.1.0-portable.exe'
const INSTALLED_EXE = 'C:\\Users\\nadia\\AppData\\Local\\Programs\\Bluely\\Bluely.exe'
const ALL_USERS_EXE = 'C:\\Program Files\\Bluely\\Bluely.exe'

/** Electron's FormatCommandLineString on Windows: the quoted exe, then the args. */
const commandLine = (path: string, args: string[] = []) => [`"${path}"`, ...args].join(' ')

/**
 * Electron's Windows login items (shell/browser/browser_win.cc), reduced to the Run key:
 * enabling writes the value under `name`, disabling deletes it by name, and openAtLogin is true
 * when the value named after the AppUserModelId is exactly `"path" args`.
 */
function fakeLoginItems(): void {
  electron.setLoginItemSettings.mockImplementation((s: LoginItemSettings) => {
    const name = s.name ?? win32.APP_USER_MODEL_ID
    if (s.openAtLogin) electron.runKey.set(name, commandLine(s.path ?? process.execPath, s.args))
    else electron.runKey.delete(name)
  })
  electron.getLoginItemSettings.mockImplementation((o: LoginItemSettings = {}) => ({
    openAtLogin:
      electron.runKey.get(win32.APP_USER_MODEL_ID) ===
      commandLine(o.path ?? process.execPath, o.args),
  }))
}

const originals = {
  platform: Object.getOwnPropertyDescriptor(process, 'platform'),
  execPath: Object.getOwnPropertyDescriptor(process, 'execPath'),
}

/** process.platform / process.execPath are plain data properties: redefine, then restore. */
function stubProcess(key: keyof typeof originals, value: string): void {
  Object.defineProperty(process, key, { value, configurable: true, writable: true })
}

function stubPlatform(value: NodeJS.Platform): void {
  stubProcess('platform', value)
}

beforeEach(() => {
  electron.setLoginItemSettings.mockReset()
  electron.getLoginItemSettings.mockReset()
  electron.runKey.clear()
  electron.isPackaged = true
  fakeLoginItems()
  stubProcess('execPath', TEMP_EXE)
  vi.stubEnv('PORTABLE_EXECUTABLE_DIR', undefined)
  vi.stubEnv('PORTABLE_EXECUTABLE_FILE', undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
  for (const [key, descriptor] of Object.entries(originals)) {
    if (descriptor) Object.defineProperty(process, key, descriptor)
  }
})

describe('win32 launch at startup', () => {
  it('registers the running exe with --hidden in an installed build', () => {
    win32.setLaunchAtStartup(true)
    expect(electron.setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: true,
      path: TEMP_EXE,
      args: ['--hidden'],
      name: win32.APP_USER_MODEL_ID,
    })
  })

  it('registers the portable launcher, not the temporary extracted copy', () => {
    vi.stubEnv('PORTABLE_EXECUTABLE_DIR', 'D:\\Tools')
    vi.stubEnv('PORTABLE_EXECUTABLE_FILE', PORTABLE_EXE)

    win32.setLaunchAtStartup(true)

    const settings = electron.setLoginItemSettings.mock.calls[0]?.[0]
    expect(settings).toMatchObject({ openAtLogin: true, path: PORTABLE_EXE, args: ['--hidden'] })
    expect(settings.path).not.toBe(TEMP_EXE)
  })

  it('refuses to register a portable build whose launcher path is unknown', () => {
    vi.stubEnv('PORTABLE_EXECUTABLE_DIR', 'D:\\Tools')

    expect(win32.canLaunchAtStartup()).toBe(false)
    expect(() => win32.setLaunchAtStartup(true)).toThrow(/portable launcher/)
    expect(electron.setLoginItemSettings).not.toHaveBeenCalled()

    // Turning it off still works (Electron deletes the value by name).
    win32.setLaunchAtStartup(false)
    expect(electron.setLoginItemSettings).toHaveBeenCalledWith(
      expect.objectContaining({ openAtLogin: false, args: [], name: win32.APP_USER_MODEL_ID }),
    )
  })

  it('removes the same registry value it wrote', () => {
    win32.setLaunchAtStartup(true)
    win32.setLaunchAtStartup(false)
    const [on, off] = electron.setLoginItemSettings.mock.calls.map((c) => c[0])
    expect(off).toMatchObject({ openAtLogin: false, args: [] })
    expect(off.name).toBe(on.name)
  })

  it('startupExecutable() / canLaunchAtStartup() for each kind of build', () => {
    expect(win32.startupExecutable({})).toBe(TEMP_EXE)
    expect(
      win32.startupExecutable({
        PORTABLE_EXECUTABLE_DIR: 'D:\\Tools',
        PORTABLE_EXECUTABLE_FILE: PORTABLE_EXE,
      }),
    ).toBe(PORTABLE_EXE)
    expect(win32.startupExecutable({ PORTABLE_EXECUTABLE_DIR: 'D:\\Tools' })).toBeNull()
    expect(win32.canLaunchAtStartup({})).toBe(true)
    expect(win32.canLaunchAtStartup({ PORTABLE_EXECUTABLE_DIR: 'D:\\Tools' })).toBe(false)
  })
})

describe('platform dispatch', () => {
  it('canLaunchAtStartup() on Windows follows the build, and is false where unsupported', () => {
    stubPlatform('win32')
    expect(platform.canLaunchAtStartup()).toBe(true)
    vi.stubEnv('PORTABLE_EXECUTABLE_DIR', 'D:\\Tools')
    expect(platform.isPortableBuild()).toBe(true)
    expect(platform.canLaunchAtStartup()).toBe(false)
    vi.stubEnv('PORTABLE_EXECUTABLE_FILE', PORTABLE_EXE)
    expect(platform.canLaunchAtStartup()).toBe(true)

    stubPlatform('linux')
    expect(platform.canLaunchAtStartup()).toBe(false)
    stubPlatform('darwin')
    expect(platform.canLaunchAtStartup()).toBe(true)
  })

  it('setLaunchAtStartup() on Windows goes through the win32 implementation', () => {
    stubPlatform('win32')
    vi.stubEnv('PORTABLE_EXECUTABLE_DIR', 'D:\\Tools')
    vi.stubEnv('PORTABLE_EXECUTABLE_FILE', PORTABLE_EXE)
    platform.setLaunchAtStartup(true)
    expect(electron.setLoginItemSettings).toHaveBeenCalledWith(
      expect.objectContaining({ path: PORTABLE_EXE, name: win32.APP_USER_MODEL_ID }),
    )
  })
})

describe('launch at startup is re-synced with the setting at every start', () => {
  const run = () => electron.runKey.get(win32.APP_USER_MODEL_ID)
  const hidden = (exe: string) => commandLine(exe, ['--hidden'])

  beforeEach(() => stubPlatform('win32'))

  it('registers again after an uninstall removed the entry but kept the setting', () => {
    // The Run key is empty: build/installer.nsh deleted the value, %APPDATA%\Bluely survived.
    stubProcess('execPath', INSTALLED_EXE)
    platform.syncLaunchAtStartup(true)
    expect(Object.fromEntries(electron.runKey)).toEqual({
      [win32.APP_USER_MODEL_ID]: hidden(INSTALLED_EXE),
    })
  })

  it('repoints an entry left by an install in another folder (old uninstaller ran as update)', () => {
    electron.runKey.set(win32.APP_USER_MODEL_ID, hidden(INSTALLED_EXE))
    stubProcess('execPath', ALL_USERS_EXE)
    platform.syncLaunchAtStartup(true)
    expect(run()).toBe(hidden(ALL_USERS_EXE))
  })

  it('repoints a moved portable exe at its launcher, never at the temporary copy', () => {
    electron.runKey.set(
      win32.APP_USER_MODEL_ID,
      hidden('C:\\Users\\nadia\\Downloads\\Bluely-0.1.0-portable.exe'),
    )
    vi.stubEnv('PORTABLE_EXECUTABLE_DIR', 'D:\\Tools')
    vi.stubEnv('PORTABLE_EXECUTABLE_FILE', PORTABLE_EXE)
    platform.syncLaunchAtStartup(true)
    expect(run()).toBe(hidden(PORTABLE_EXE))
  })

  it('leaves a correct entry alone, so a Task Manager "Disabled" choice is kept', () => {
    stubProcess('execPath', INSTALLED_EXE)
    electron.runKey.set(win32.APP_USER_MODEL_ID, hidden(INSTALLED_EXE))
    platform.syncLaunchAtStartup(true)
    expect(electron.getLoginItemSettings).toHaveBeenCalledWith({
      path: INSTALLED_EXE,
      args: ['--hidden'],
    })
    // Rewriting would also delete the StartupApproved value (Electron's `enabled: true` default).
    expect(electron.setLoginItemSettings).not.toHaveBeenCalled()
  })

  it('removes an entry the setting does not want, wherever it points', () => {
    electron.runKey.set(win32.APP_USER_MODEL_ID, hidden(INSTALLED_EXE))
    stubProcess('execPath', ALL_USERS_EXE)
    platform.syncLaunchAtStartup(false)
    expect(electron.runKey.size).toBe(0)
  })

  it('registers nothing for a portable build started without its launcher', () => {
    vi.stubEnv('PORTABLE_EXECUTABLE_DIR', 'D:\\Tools')
    expect(() => platform.syncLaunchAtStartup(true)).not.toThrow()
    expect(electron.setLoginItemSettings).not.toHaveBeenCalled()
  })

  it("never touches the installed app's entry from an unpackaged (dev/test) run", () => {
    electron.isPackaged = false
    electron.runKey.set(win32.APP_USER_MODEL_ID, hidden(INSTALLED_EXE))
    platform.syncLaunchAtStartup(false)
    platform.syncLaunchAtStartup(true)
    expect(electron.setLoginItemSettings).not.toHaveBeenCalled()
    expect(run()).toBe(hidden(INSTALLED_EXE))
  })

  it('does nothing where launch at startup is unsupported', () => {
    stubPlatform('linux')
    platform.syncLaunchAtStartup(true)
    platform.syncLaunchAtStartup(false)
    expect(electron.setLoginItemSettings).not.toHaveBeenCalled()
  })

  it('macOS: changes the login item only when it differs from the setting', () => {
    stubPlatform('darwin')
    electron.getLoginItemSettings.mockReturnValue({ openAtLogin: true })
    platform.syncLaunchAtStartup(true)
    expect(electron.setLoginItemSettings).not.toHaveBeenCalled()
    platform.syncLaunchAtStartup(false)
    expect(electron.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: false })
  })
})

describe('core handlers re-sync launch at startup when Bluely starts', () => {
  function start(launchAtStartup: boolean) {
    const log = { warn: vi.fn(), setDebug: vi.fn() }
    const ctx = {
      settings: {
        get: () => ({ general: { launchAtStartup }, advanced: { devLogging: false } }),
        onChange: vi.fn(),
      },
      secrets: {},
      events: {},
      overlay: {},
      log,
    } as unknown as CoreContext
    registerCoreHandlers(ctx, { quit: () => undefined })
    return { log }
  }

  beforeEach(() => {
    handlers.clear()
    stubPlatform('win32')
    stubProcess('execPath', INSTALLED_EXE)
  })

  it('registers the entry when the stored setting is on but nothing is registered', () => {
    start(true)
    expect(electron.runKey.get(win32.APP_USER_MODEL_ID)).toBe(
      commandLine(INSTALLED_EXE, ['--hidden']),
    )
  })

  it('removes a leftover entry when the stored setting is off', () => {
    electron.runKey.set(win32.APP_USER_MODEL_ID, commandLine(ALL_USERS_EXE, ['--hidden']))
    start(false)
    expect(electron.runKey.size).toBe(0)
  })

  it('logs and carries on when the entry cannot be written', () => {
    electron.setLoginItemSettings.mockImplementation(() => {
      throw new Error('Access is denied')
    })
    const { log } = start(true)
    expect(log.warn).toHaveBeenCalledWith('Could not re-sync launch at startup', expect.any(Error))
    expect(handlers.has('settings:get')).toBe(true)
  })
})

describe('uninstaller cleans up the launch-at-startup entry', () => {
  const builderYml = readFileSync(join(ROOT, 'electron-builder.yml'), 'utf8')

  it('uses the app id as AppUserModelId (= the Run value name)', () => {
    expect(builderYml).toMatch(new RegExp(`^appId: ${win32.APP_USER_MODEL_ID}$`, 'm'))
  })

  it('electron-builder includes build/installer.nsh in the NSIS installer', () => {
    const nsis = builderYml.split(/^nsis:\s*$/m)[1]?.split(/^\S/m)[0] ?? ''
    expect(nsis).toMatch(/^ {2}include: build\/installer\.nsh\s*$/m)
  })

  it('customUnInstall deletes both Run values, except during an update', () => {
    const nsh = readFileSync(join(ROOT, 'build', 'installer.nsh'), 'utf8')
    const macro = /!macro customUnInstall\b([\s\S]*?)!macroend/.exec(nsh)?.[1]
    expect(macro).toBeDefined()
    const body = (macro ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith(';'))
    // ${APP_ID} is electron-builder's define for appId, asserted above to be the value name.
    expect(body).toEqual([
      '${ifNot} ${isUpdated}',
      'DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run" "${APP_ID}"',
      'DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run" "${APP_ID}"',
      '${endIf}',
    ])
  })
})
