/**
 * Settings › General › Launch at startup follows what the main process says this build can do
 * (app:getInfo().canLaunchAtStartup, from src/main/platform): on Windows the toggle works; where
 * it cannot (non-Windows dev runs, a portable build without its launcher path) it is disabled,
 * shown off and explained, instead of a switch that saves "On" and does nothing.
 *
 * Runs the real app (out/) with an isolated data folder. On Windows it never turns the option on:
 * an unpackaged run would write the same Run value name as an installed Bluely.
 */
import { expect, test } from '@playwright/test'
import { settings } from '../../src/shared/i18n/en/settings'
import type { AppInfo } from '../../src/shared/types'
import { launchApp, type LaunchedApp } from './helpers'

let ctx: LaunchedApp

test.beforeAll(async () => {
  ctx = await launchApp()
})

test.afterAll(async () => {
  await ctx?.app.close()
})

test('the Launch at startup toggle is usable only where it can work', async () => {
  const { app, main } = ctx
  const info = await main.evaluate(() => window.bluely.invoke('app:getInfo', undefined))
  expect(info.ok).toBe(true)
  const { canLaunchAtStartup } = (info as { ok: true; data: AppInfo }).data
  expect(canLaunchAtStartup).toBe(process.platform === 'win32' || process.platform === 'darwin')

  const general = canLaunchAtStartup
    ? { onboardingComplete: true }
    : // Stored "on" (e.g. settings copied from a Windows PC) must not show as on.
      { onboardingComplete: true, launchAtStartup: true }
  const saved = await main.evaluate(
    (patch) => window.bluely.invoke('settings:update', { patch: { general: patch } }),
    general,
  )
  expect(saved.ok).toBe(true)
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send('settings:open', { page: 'general' })
    }
  })

  const toggle = main.getByRole('switch', { name: settings.general.startupTitle })
  await expect(toggle).toBeVisible()
  if (canLaunchAtStartup) {
    await expect(toggle).toBeEnabled()
    await expect(main.getByText(settings.general.startupDescription)).toBeVisible()
    await expect(main.getByText(settings.general.startupUnavailable)).toHaveCount(0)
  } else {
    await expect(toggle).toBeDisabled()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await expect(main.getByText(settings.general.startupUnavailable)).toBeVisible()
    await expect(main.getByText(settings.general.startupDescription)).toHaveCount(0)
  }
})
