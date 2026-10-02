import { expect, test } from '@playwright/test'
import { launchApp, type LaunchedApp } from './helpers'

let ctx: LaunchedApp

test.beforeAll(async () => {
  ctx = await launchApp()
})

test.afterAll(async () => {
  await ctx?.app.close()
})

test('app launches with a visible main window served over bluely://', async () => {
  await expect(ctx.main).toHaveTitle('Bluely')
  expect(ctx.main.url()).toBe('bluely://app/main/index.html')
  const visible = await ctx.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().some((w) => w.isVisible() && w.getTitle() === 'Bluely'),
  )
  expect(visible).toBe(true)
})

test('renderer cannot reach the network or Node', async () => {
  const result = await ctx.main.evaluate(async () => {
    const hasRequire = typeof (globalThis as { require?: unknown }).require !== 'undefined'
    let fetched = 'blocked'
    try {
      await fetch('https://example.com')
      fetched = 'allowed'
    } catch {
      fetched = 'blocked'
    }
    return { hasRequire, fetched }
  })
  expect(result).toEqual({ hasRequire: false, fetched: 'blocked' })
})

test('IPC payloads are validated', async () => {
  const bad = await ctx.main.evaluate(() => window.bluely.invoke('settings:update', { patch: 5 }))
  expect(bad).toMatchObject({ ok: false, error: { code: 'invalid_payload' } })
})
