import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface LaunchedApp {
  app: ElectronApplication
  main: Page
  userData: string
  logs: string[]
}

/** Launches the built app (out/) with an isolated data folder. */
export async function launchApp(
  env: Record<string, string> = {},
  extraArgs: string[] = [],
): Promise<LaunchedApp> {
  const userData = mkdtempSync(join(tmpdir(), 'bluely-e2e-'))
  const args = [...extraArgs, '.']
  // Chromium refuses to start as root without this (Linux containers only).
  if (process.platform === 'linux' && process.getuid?.() === 0) args.unshift('--no-sandbox')
  const app = await electron.launch({
    args,
    cwd: join(__dirname, '..', '..'),
    env: { ...process.env, BLUELY_USER_DATA_DIR: userData, BLUELY_TEST: '1', ...env } as Record<
      string,
      string
    >,
  })
  const logs: string[] = []
  app.process().stdout?.on('data', (d) => logs.push(String(d)))
  app.process().stderr?.on('data', (d) => logs.push(String(d)))
  const main = await app.firstWindow()
  await main.waitForLoadState('domcontentloaded')
  return { app, main, userData, logs }
}
