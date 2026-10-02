import { app } from 'electron'
import { join } from 'node:path'
import { OPENROUTER_BASE_URL } from '@shared/constants'

/**
 * Process-wide environment flags. Development/testing overrides are only honoured in
 * unpackaged builds so a packaged Bluely can never be pointed at another API host.
 */
export interface Env {
  isDev: boolean
  isPackaged: boolean
  isTest: boolean
  /** Vite dev server URL in `pnpm dev`. */
  rendererUrl: string | null
  openRouterBaseUrl: string
  /** Base URL used for the GitHub update feed (null = default). */
  verbose: boolean
}

export function readEnv(): Env {
  const isPackaged = app.isPackaged
  const devOverridesAllowed = !isPackaged
  const rendererUrl = devOverridesAllowed ? (process.env['ELECTRON_RENDERER_URL'] ?? null) : null
  const baseOverride = devOverridesAllowed ? process.env['BLUELY_OPENROUTER_BASE_URL'] : undefined
  return {
    isDev: !isPackaged,
    isPackaged,
    isTest: devOverridesAllowed && process.env['BLUELY_TEST'] === '1',
    rendererUrl,
    openRouterBaseUrl: (baseOverride && baseOverride.trim()) || OPENROUTER_BASE_URL,
    verbose: process.env['BLUELY_VERBOSE'] === '1',
  }
}

/**
 * Must run before app 'ready'. In unpackaged builds BLUELY_USER_DATA_DIR isolates test runs.
 * Packaged builds always use %APPDATA%\Bluely.
 */
export function applyUserDataOverride(): void {
  const override = process.env['BLUELY_USER_DATA_DIR']
  if (!app.isPackaged && override) {
    app.setPath('userData', override)
  }
}

export interface AppPaths {
  userData: string
  dbFile: string
  keyFile: string
  logsDir: string
  screenshotsDir: string
}

export function resolvePaths(): AppPaths {
  const userData = app.getPath('userData')
  return {
    userData,
    dbFile: join(userData, 'bluely.db'),
    keyFile: join(userData, 'openrouter-key.bin'),
    logsDir: join(userData, 'logs'),
    screenshotsDir: join(userData, 'screenshots'),
  }
}
