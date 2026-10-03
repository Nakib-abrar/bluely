/**
 * Smoke test of the packaged app (electron-builder output), the way users get it: app.asar,
 * the unpacked native SQLite module, bundled VAD/ONNX assets and resources. Opt-in: set
 * BLUELY_PACKAGED_EXE to the built executable, e.g. release\win-unpacked\Bluely.exe after
 * `pnpm dist:dir` (CI: .github/workflows/loopback-windows.yml).
 *
 * A packaged build ignores the test overrides (data folder, API host), so this uses the real
 * data folder of the account running it and only calls read-only/local APIs. One side effect
 * on Windows: like every start of a packaged build, it re-syncs the launch-at-startup entry
 * (HKCU\...\Run) with that account's setting. An entry for another copy of Bluely that still
 * exists (e.g. the installed app) is left alone; with the setting on and no entry (or one for a
 * deleted exe), this exe is registered. See syncLaunchAtStartup in src/main/platform/win32.
 */
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import type { AppInfo } from '@shared/types'

const EXE = process.env['BLUELY_PACKAGED_EXE'] ?? ''
test.skip(!EXE, 'Set BLUELY_PACKAGED_EXE to a packaged Bluely executable')
test.describe.configure({ mode: 'serial' })

let app: ElectronApplication

test.afterAll(async () => {
  await app?.close()
})

test('the packaged app starts with its main window on bluely://', async () => {
  const args: string[] = []
  if (process.platform === 'linux' && process.getuid?.() === 0) args.push('--no-sandbox')
  app = await electron.launch({ executablePath: EXE, args })
  const main = await app.firstWindow()
  await main.waitForLoadState('domcontentloaded')
  expect(main.url()).toMatch(/^bluely:\/\/app\/main\//)
  await expect(main.locator('body')).toBeVisible()
  // Real UI, not a blank page: either onboarding (fresh profile) or the home page.
  await expect(main.getByRole('heading').first()).toBeVisible({ timeout: 20_000 })
})

test('it reports a packaged build and opens its SQLite database', async () => {
  const main = await app.firstWindow()
  const info = await main.evaluate(() => window.bluely.invoke('app:getInfo', undefined))
  expect(info.ok).toBe(true)
  const data = (info as { ok: true; data: AppInfo }).data
  expect(data.isPackaged).toBe(true)
  expect(data.devMode).toBe(false)
  expect(data.electron).toBe('43.7.7')
  console.log(`[packaged] ${JSON.stringify(data)}`)
  // Listing meetings goes through better-sqlite3 (a native module loaded from app.asar.unpacked).
  const list = await main.evaluate(() => window.bluely.invoke('sessions:list', { limit: 5 }))
  expect(list).toMatchObject({ ok: true })
})

test('the bundled VAD model and ONNX runtime are served to the renderer', async () => {
  const main = await app.firstWindow()
  const sizes = await main.evaluate(async () => {
    const get = async (p: string) => {
      const r = await fetch(new URL(p, location.href).href)
      return r.ok ? (await r.arrayBuffer()).byteLength : -r.status
    }
    return {
      model: await get('/vad/silero_vad_v5.onnx'),
      wasm: await get('/vad/ort-wasm-simd-threaded.wasm'),
      loader: await get('/vad/ort-wasm-simd-threaded.mjs'),
    }
  })
  expect(sizes.model).toBeGreaterThan(1_000_000)
  expect(sizes.wasm).toBeGreaterThan(1_000_000)
  expect(sizes.loader).toBeGreaterThan(1_000)
})

test('the main window is shown and the renderer stays offline', async () => {
  const visible = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((b) => b.webContents.getURL().includes('/main/'))
    return w ? w.isVisible() : null
  })
  expect(visible).toBe(true)
  const main = await app.firstWindow()
  const blocked = await main.evaluate(async () => {
    try {
      await fetch('https://example.com/')
      return false
    } catch {
      return true
    }
  })
  expect(blocked).toBe(true)
})

test('a session starts capture in the overlay and stops cleanly', async () => {
  const main = await app.firstWindow()
  await main.evaluate(() =>
    window.bluely.invoke('settings:update', { patch: { general: { onboardingComplete: true } } }),
  )
  const overlayPromise = app.waitForEvent('window', (w) => w.url().includes('/overlay/'))
  const started = await main.evaluate(() => window.bluely.invoke('session:start', {}))
  expect(started).toMatchObject({ ok: true })
  await overlayPromise
  // Both channels leave 'starting' once the capture graph and the Silero VAD are up (or fail).
  // With a sound card (Windows CI: VB-CABLE) desktop audio must actually be listening.
  const needLoopback = process.platform === 'win32' && process.env['BLUELY_E2E_AUDIO'] === '1'
  let sessionId: string | null = null
  await expect
    .poll(
      async () => {
        const s = await main.evaluate(() => window.bluely.invoke('session:getState', undefined))
        if (!s.ok) return 'error'
        sessionId = s.data.sessionId
        const { me, them } = s.data.audio
        if (s.data.status !== 'live' || me.state === 'starting' || them.state === 'starting') {
          return `${s.data.status}/${me.state}/${them.state}`
        }
        return needLoopback ? `them:${them.state}` : 'settled'
      },
      { timeout: 30_000 },
    )
    .toBe(needLoopback ? 'them:listening' : 'settled')
  const stopped = await main.evaluate(() => window.bluely.invoke('session:stop', undefined))
  expect(stopped).toMatchObject({ ok: true })
  await expect
    .poll(
      async () => {
        const s = await main.evaluate(() => window.bluely.invoke('session:getState', undefined))
        return s.ok ? s.data.status : 'error'
      },
      { timeout: 60_000 },
    )
    .toBe('idle')
  // Leave the real history as it was.
  if (sessionId) {
    const id = sessionId
    await main.evaluate((sid) => window.bluely.invoke('sessions:delete', { id: sid }), id)
  }
})
