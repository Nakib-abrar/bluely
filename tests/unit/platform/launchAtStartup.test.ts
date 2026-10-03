import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CoreContext } from '@main/context'
import type { AppInfo } from '@shared/types'

interface LoginItemSettings {
  openAtLogin?: boolean
  path?: string
  args?: string[]
  name?: string
  enabled?: boolean
}

const electron = vi.hoisted(() => ({
  setLoginItemSettings: vi.fn(),
  getLoginItemSettings: vi.fn(),
  setAppUserModelId: vi.fn(),
  isPackaged: true,
  /** %APPDATA%\Bluely: a temporary folder per test. */
  userData: '',
  /** HKCU\...\CurrentVersion\Run as Electron writes and reads it: value name -> command line. */
  runKey: new Map<string, string>(),
  /** Value names turned off in Task Manager (a "disabled" StartupApproved\Run value). */
  disabled: new Set<string>(),
}))

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return electron.isPackaged
    },
    getPath: () => electron.userData,
    getName: () => 'Bluely',
    getVersion: () => '0.1.0',
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
/** The exe of a Run command line written by commandLine(). */
const programOf = (cmd: string) => cmd.slice(1, cmd.indexOf('"', 1))

/**
 * Electron's Windows login items (shell/browser/browser_win.cc), reduced to the Run key and
 * StartupApproved: enabling writes the value under `name` and, unless `enabled: false`, clears
 * a Task Manager "Disabled"; disabling deletes both by name. openAtLogin is true when the value
 * named after the AppUserModelId is exactly `"path" args`; launchItems lists the values whose
 * exe is `path` (case-insensitive), with `enabled` from StartupApproved.
 */
function fakeLoginItems(): void {
  electron.setLoginItemSettings.mockImplementation((s: LoginItemSettings) => {
    const name = s.name ?? win32.APP_USER_MODEL_ID
    if (s.openAtLogin) {
      electron.runKey.set(name, commandLine(s.path ?? process.execPath, s.args))
      if (s.enabled === false) electron.disabled.add(name)
      else electron.disabled.delete(name)
    } else {
      electron.runKey.delete(name)
      electron.disabled.delete(name)
    }
  })
  electron.getLoginItemSettings.mockImplementation((o: LoginItemSettings = {}) => {
    const path = o.path ?? process.execPath
    return {
      openAtLogin: electron.runKey.get(win32.APP_USER_MODEL_ID) === commandLine(path, o.args),
      launchItems: [...electron.runKey]
        .filter(([, cmd]) => programOf(cmd).toLowerCase() === path.toLowerCase())
        .map(([name, cmd]) => ({
          name,
          path: programOf(cmd),
          args: cmd
            .slice(programOf(cmd).length + 3)
            .split(' ')
            .filter(Boolean),
          scope: 'user',
          enabled: !electron.disabled.has(name),
        })),
    }
  })
}

/** The exe recorded in %APPDATA%\Bluely\launch-at-startup.json, or null. */
function recorded(): string | null {
  const file = join(electron.userData, win32.STARTUP_RECORD_FILE)
  if (!existsSync(file)) return null
  return (JSON.parse(readFileSync(file, 'utf8')) as { path: string }).path
}

function record(exe: string): void {
  writeFileSync(join(electron.userData, win32.STARTUP_RECORD_FILE), JSON.stringify({ path: exe }))
}

/** An exe that exists (a file in this test's temporary folder). */
function existingExe(...parts: string[]): string {
  const file = join(electron.userData, '..', ...parts)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, '')
  return file
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
  electron.disabled.clear()
  electron.isPackaged = true
  electron.userData = join(mkdtempSync(join(tmpdir(), 'bluely-startup-')), 'Bluely')
  mkdirSync(electron.userData)
  fakeLoginItems()
  stubProcess('execPath', TEMP_EXE)
  vi.stubEnv('PORTABLE_EXECUTABLE_DIR', undefined)
  vi.stubEnv('PORTABLE_EXECUTABLE_FILE', undefined)
})

afterEach(() => {
  rmSync(dirname(electron.userData), { recursive: true, force: true })
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
  const sync = (wanted: boolean) => platform.syncLaunchAtStartup(() => wanted)

  beforeEach(() => stubPlatform('win32'))

  it('registers again after an uninstall removed the entry but kept the setting', async () => {
    // The Run key is empty: build/installer.nsh deleted the value, %APPDATA%\Bluely survived.
    stubProcess('execPath', INSTALLED_EXE)
    await sync(true)
    expect(Object.fromEntries(electron.runKey)).toEqual({
      [win32.APP_USER_MODEL_ID]: hidden(INSTALLED_EXE),
    })
    expect(recorded()).toBe(INSTALLED_EXE)
  })

  it('repoints an entry left by an install in another folder (old uninstaller ran as update)', async () => {
    // INSTALLED_EXE does not exist (here: a Windows path): that folder is gone.
    record(INSTALLED_EXE)
    electron.runKey.set(win32.APP_USER_MODEL_ID, hidden(INSTALLED_EXE))
    stubProcess('execPath', ALL_USERS_EXE)
    await sync(true)
    expect(run()).toBe(hidden(ALL_USERS_EXE))
    expect(recorded()).toBe(ALL_USERS_EXE)
  })

  it('keeps a Task Manager "Disabled" choice when it repoints a stale entry', async () => {
    record(INSTALLED_EXE)
    electron.runKey.set(win32.APP_USER_MODEL_ID, hidden(INSTALLED_EXE))
    electron.disabled.add(win32.APP_USER_MODEL_ID)
    stubProcess('execPath', ALL_USERS_EXE)
    await sync(true)
    expect(run()).toBe(hidden(ALL_USERS_EXE))
    expect(electron.disabled.has(win32.APP_USER_MODEL_ID)).toBe(true)
  })

  it('repoints a moved portable exe at its launcher, never at the temporary copy', async () => {
    const before = 'C:\\Users\\nadia\\Downloads\\Bluely-0.1.0-portable.exe'
    record(before)
    electron.runKey.set(win32.APP_USER_MODEL_ID, hidden(before))
    vi.stubEnv('PORTABLE_EXECUTABLE_DIR', 'D:\\Tools')
    vi.stubEnv('PORTABLE_EXECUTABLE_FILE', PORTABLE_EXE)
    await sync(true)
    expect(run()).toBe(hidden(PORTABLE_EXE))
    expect(recorded()).toBe(PORTABLE_EXE)
  })

  it('repoints an entry no copy recorded (written before the record existed)', async () => {
    electron.runKey.set(win32.APP_USER_MODEL_ID, hidden(INSTALLED_EXE))
    stubProcess('execPath', ALL_USERS_EXE)
    await sync(true)
    expect(run()).toBe(hidden(ALL_USERS_EXE))
  })

  it('leaves the entry of another copy that still exists alone, whatever this copy wants', async () => {
    // The installed app turned Launch at startup on, and the user disabled it in Task Manager.
    const installed = existingExe('Programs', 'Bluely', 'Bluely.exe')
    stubProcess('execPath', installed)
    win32.setLaunchAtStartup(true)
    electron.disabled.add(win32.APP_USER_MODEL_ID)
    electron.setLoginItemSettings.mockClear()

    // Then a portable copy (same %APPDATA%\Bluely, same value name) starts, with either setting.
    stubProcess('execPath', TEMP_EXE)
    vi.stubEnv('PORTABLE_EXECUTABLE_DIR', 'D:\\Tools')
    vi.stubEnv('PORTABLE_EXECUTABLE_FILE', PORTABLE_EXE)
    await sync(true)
    await sync(false)
    // So do release\win-unpacked\Bluely.exe and the packaged E2E test on a developer's PC.
    vi.stubEnv('PORTABLE_EXECUTABLE_DIR', undefined)
    vi.stubEnv('PORTABLE_EXECUTABLE_FILE', undefined)
    stubProcess('execPath', 'C:\\src\\bluely\\release\\win-unpacked\\Bluely.exe')
    await sync(true)
    await sync(false)

    expect(electron.setLoginItemSettings).not.toHaveBeenCalled()
    expect(run()).toBe(hidden(installed))
    expect(electron.disabled.has(win32.APP_USER_MODEL_ID)).toBe(true)
    expect(recorded()).toBe(installed)
  })

  it('leaves a correct entry alone, so a Task Manager "Disabled" choice is kept', async () => {
    stubProcess('execPath', INSTALLED_EXE)
    electron.runKey.set(win32.APP_USER_MODEL_ID, hidden(INSTALLED_EXE))
    await sync(true)
    expect(electron.getLoginItemSettings).toHaveBeenCalledWith({
      path: INSTALLED_EXE,
      args: ['--hidden'],
    })
    // Rewriting would also delete the StartupApproved value (Electron's `enabled: true` default).
    expect(electron.setLoginItemSettings).not.toHaveBeenCalled()
    // An entry written before the record existed is recorded now.
    expect(recorded()).toBe(INSTALLED_EXE)
  })

  it("removes this exe's entry when the setting is off", async () => {
    stubProcess('execPath', INSTALLED_EXE)
    win32.setLaunchAtStartup(true)
    await sync(false)
    expect(electron.runKey.size).toBe(0)
    expect(recorded()).toBeNull()
  })

  it('removes an entry for a recorded exe that is gone when the setting is off', async () => {
    record(INSTALLED_EXE)
    electron.runKey.set(win32.APP_USER_MODEL_ID, hidden(INSTALLED_EXE))
    stubProcess('execPath', ALL_USERS_EXE)
    await sync(false)
    expect(electron.runKey.size).toBe(0)
  })

  it('leaves an entry no copy recorded alone when the setting is off', async () => {
    electron.runKey.set(win32.APP_USER_MODEL_ID, hidden(INSTALLED_EXE))
    stubProcess('execPath', ALL_USERS_EXE)
    await sync(false)
    expect(electron.setLoginItemSettings).not.toHaveBeenCalled()
  })

  it('never undoes a change the user makes while it checks the other exe', async () => {
    record(INSTALLED_EXE)
    electron.runKey.set(win32.APP_USER_MODEL_ID, hidden(INSTALLED_EXE))
    stubProcess('execPath', ALL_USERS_EXE)
    let wanted = true
    const pending = platform.syncLaunchAtStartup(() => wanted)
    // Settings › General: the user turns it off; the settings handler deletes the entry at once.
    wanted = false
    win32.setLaunchAtStartup(false)
    await pending
    expect(electron.runKey.size).toBe(0)
  })

  it('registers nothing for a portable build started without its launcher', async () => {
    vi.stubEnv('PORTABLE_EXECUTABLE_DIR', 'D:\\Tools')
    await expect(sync(true)).resolves.toBeUndefined()
    expect(electron.setLoginItemSettings).not.toHaveBeenCalled()
  })

  it("never touches the installed app's entry from an unpackaged (dev/test) run", async () => {
    electron.isPackaged = false
    record(INSTALLED_EXE)
    electron.runKey.set(win32.APP_USER_MODEL_ID, hidden(INSTALLED_EXE))
    await sync(false)
    await sync(true)
    expect(electron.setLoginItemSettings).not.toHaveBeenCalled()
    expect(run()).toBe(hidden(INSTALLED_EXE))
  })

  it('does nothing where launch at startup is unsupported', async () => {
    stubPlatform('linux')
    await sync(true)
    await sync(false)
    expect(electron.setLoginItemSettings).not.toHaveBeenCalled()
  })

  it('macOS: changes the login item only when it differs from the setting', async () => {
    stubPlatform('darwin')
    electron.getLoginItemSettings.mockReturnValue({ openAtLogin: true })
    await sync(true)
    expect(electron.setLoginItemSettings).not.toHaveBeenCalled()
    await sync(false)
    expect(electron.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: false })
  })
})

describe('core handlers', () => {
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
      paths: { userData: electron.userData },
      env: { isDev: false },
      log,
    } as unknown as CoreContext
    registerCoreHandlers(ctx, { quit: () => undefined })
    return { log }
  }

  const appInfo = () => (handlers.get('app:getInfo') as () => AppInfo)()

  beforeEach(() => {
    handlers.clear()
    stubPlatform('win32')
    stubProcess('execPath', INSTALLED_EXE)
  })

  it('register the entry when the stored setting is on but nothing is registered', async () => {
    start(true)
    await vi.waitFor(() =>
      expect(electron.runKey.get(win32.APP_USER_MODEL_ID)).toBe(
        commandLine(INSTALLED_EXE, ['--hidden']),
      ),
    )
  })

  it("remove this exe's leftover entry when the stored setting is off", async () => {
    electron.runKey.set(win32.APP_USER_MODEL_ID, commandLine(INSTALLED_EXE, ['--hidden']))
    start(false)
    await vi.waitFor(() => expect(electron.runKey.size).toBe(0))
  })

  it('log and carry on when the entry cannot be written', async () => {
    electron.setLoginItemSettings.mockImplementation(() => {
      throw new Error('Access is denied')
    })
    const { log } = start(true)
    expect(handlers.has('settings:get')).toBe(true)
    await vi.waitFor(() =>
      expect(log.warn).toHaveBeenCalledWith(
        'Could not re-sync launch at startup',
        expect.any(Error),
      ),
    )
  })

  it('tell Settings (app:getInfo) whether launch at startup can work in this build', () => {
    start(false)
    expect(appInfo()).toMatchObject({ isPortable: false, canLaunchAtStartup: true })

    // A portable build started through its launcher can (it registers the launcher)...
    vi.stubEnv('PORTABLE_EXECUTABLE_DIR', 'D:\\Tools')
    vi.stubEnv('PORTABLE_EXECUTABLE_FILE', PORTABLE_EXE)
    expect(appInfo()).toMatchObject({ isPortable: true, canLaunchAtStartup: true })
    // ...without its launcher path it cannot, and the toggle is disabled instead of a no-op.
    vi.stubEnv('PORTABLE_EXECUTABLE_FILE', undefined)
    expect(appInfo()).toMatchObject({ isPortable: true, canLaunchAtStartup: false })

    stubPlatform('linux')
    expect(appInfo()).toMatchObject({ isPortable: false, canLaunchAtStartup: false })
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
