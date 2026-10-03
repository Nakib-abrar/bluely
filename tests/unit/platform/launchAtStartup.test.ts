import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  setLoginItemSettings: vi.fn(),
  setAppUserModelId: vi.fn(),
}))

vi.mock('electron', () => ({
  app: {
    setLoginItemSettings: electron.setLoginItemSettings,
    setAppUserModelId: electron.setAppUserModelId,
    commandLine: { getSwitchValue: () => '', appendSwitch: () => undefined },
  },
}))

import * as platform from '@main/platform'
import * as win32 from '@main/platform/win32'

const ROOT = join(__dirname, '..', '..', '..')
/** Where electron-builder's portable launcher extracts the app (deleted when it exits). */
const TEMP_EXE = 'C:\\Users\\nadia\\AppData\\Local\\Temp\\2fQx7\\Bluely.exe'
const PORTABLE_EXE = 'D:\\Tools\\Bluely-0.1.0-portable.exe'

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
