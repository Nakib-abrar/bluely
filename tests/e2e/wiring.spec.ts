/**
 * Every invoke channel of the IPC contract has a real feature handler: the "not implemented"
 * fallback (src/main/ipc/handlers/stubs.ts) must not catch any channel in a full app start.
 */
import { expect, test } from '@playwright/test'
import { launchApp } from './helpers'

test('no IPC channel falls back to the "not implemented" stub', async () => {
  const ctx = await launchApp()
  try {
    await expect(ctx.main.locator('body')).toBeVisible()
    // Handlers are registered before the first window loads, so the log line (if any) is out.
    const stubbed = ctx.logs.join('').match(/IPC channels without a feature handler: (.*)/)
    expect(stubbed?.[1] ?? null).toBeNull()
  } finally {
    await ctx.app.close()
  }
})
