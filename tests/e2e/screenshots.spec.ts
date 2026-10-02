/**
 * Generates the README screenshots and demo GIF from the real app (mock OpenRouter backend).
 * Opt-in: BLUELY_SCREENSHOTS=1 xvfb-run -a -s "-screen 0 1920x1080x24" pnpm exec playwright test tests/e2e/screenshots.spec.ts
 * Needs ImageMagick (`convert`) and ffmpeg on PATH. Writes to docs/screenshots/.
 * If Playwright's own Chromium is missing, point PLAYWRIGHT_CHROMIUM_PATH at a Chromium binary.
 */
import { _electron as electron, chromium, expect, test, type Page } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
  MockOpenRouter,
  startMockOpenRouter as StartMock,
} from '../../scripts/mock-openrouter.mjs'
import { hasPulse, startPrivatePulse, type PrivatePulse } from './pulse'

test.skip(
  process.env['BLUELY_SCREENSHOTS'] !== '1',
  'Set BLUELY_SCREENSHOTS=1 to regenerate screenshots',
)
test.describe.configure({ mode: 'serial' })
test.setTimeout(240_000)

const ROOT = join(__dirname, '..', '..')
const OUT = join(ROOT, 'docs', 'screenshots')
const WORK = mkdtempSync(join(tmpdir(), 'bluely-shots-'))
const FRAMES = join(WORK, 'frames')
const WAV = [...readFileSync(join(ROOT, 'tests', 'fixtures', 'speech-en-16k.wav'))]
let frame = 0

function sh(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`${cmd} failed: ${r.stderr}`)
}

const HOUR = 3_600_000
const DAY = 24 * HOUR

/** Seeds a realistic history straight into the app database (schema created by a first launch). */
function seed(dbFile: string) {
  const script = `
    const Database = require(${JSON.stringify(join(ROOT, 'node_modules', 'better-sqlite3'))});
    const db = new Database(${JSON.stringify(dbFile)});
    const now = Date.now();
    const rows = ${JSON.stringify([
      ['Q3 roadmap review with Acme', 0.2, 5255000, 'builtin-sales'],
      ['Customer discovery: Northwind Traders', 0.45, 1751000, 'builtin-discovery'],
      ['Weekly design sync', 1.1, 2412000, 'builtin-standup'],
      ['Pricing call with Globex', 1.4, 3105000, 'builtin-sales'],
      ['Interview practice: system design', 3.2, 1383000, 'builtin-interview'],
      ['Investor update with Lakeside Ventures', 4.1, 2801000, 'builtin-investor'],
      ['Onboarding kickoff with Initech', 6.3, 2140000, 'builtin-general'],
    ])};
    const ins = db.prepare("INSERT INTO sessions(id, title, mode_id, started_at, ended_at, duration_ms, status, summary_json, created_at) VALUES (?, ?, ?, ?, ?, ?, 'done', ?, ?)");
    rows.forEach(([title, daysAgo, dur, mode], i) => {
      const started = now - daysAgo * ${DAY} - i * 977000;
      const summary = JSON.stringify({ notes: { title, summary: 'Reviewed goals, pricing and next steps.', keyPoints: ['Pilot with the ops team', 'Budget confirmed for Q4'], decisions: ['Start a 30-day pilot'] }, email: { subject: 'Next steps', body: 'Thanks for the call!' }, runningSummary: null, postCallError: null });
      ins.run('seed-' + i, title, mode, started, started + dur, dur, summary, started);
    });
    db.close();
  `
  const r = spawnSync(join(ROOT, 'node_modules', 'electron', 'dist', 'electron'), ['-e', script], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
  })
  if (r.status !== 0) throw new Error(`seed failed: ${r.stderr}`)
}

let pulse: PrivatePulse | null = null

async function launch(userData: string, env: Record<string, string>) {
  const args = [
    // A quiet "room" microphone so the overlay shows a normal live state in screenshots.
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${join(ROOT, 'tests', 'fixtures', 'room-noise-48k.wav')}`,
    '.',
  ]
  if (process.platform === 'linux' && process.getuid?.() === 0) args.unshift('--no-sandbox')
  if (pulse) env = { ...env, PULSE_SERVER: pulse.env['PULSE_SERVER'] as string }
  const app = await electron.launch({
    args,
    cwd: ROOT,
    env: { ...process.env, BLUELY_USER_DATA_DIR: userData, BLUELY_TEST: '1', ...env } as Record<
      string,
      string
    >,
  })
  const main = await app.firstWindow()
  await main.waitForLoadState('domcontentloaded')
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() === 'Bluely')
    w?.setBounds({ x: 40, y: 40, width: 1180, height: 760 })
  })
  return { app, main }
}

let mock: MockOpenRouter
let background = ''

test.beforeAll(async () => {
  if (hasPulse()) pulse = startPrivatePulse()
  mkdirSync(OUT, { recursive: true })
  mkdirSync(FRAMES, { recursive: true })
  const mockUrl = pathToFileURL(join(ROOT, 'scripts', 'mock-openrouter.mjs')).href
  const { startMockOpenRouter } = (await import(mockUrl)) as {
    startMockOpenRouter: typeof StartMock
  }
  mock = await startMockOpenRouter({ ttftMs: 350, tokenMs: 45, sttMs: 200 })
  // A generic video-call backdrop (no real product branding) for the overlay shots.
  // PLAYWRIGHT_CHROMIUM_PATH lets containers with a preinstalled Chromium reuse it.
  const executablePath = process.env['PLAYWRIGHT_CHROMIUM_PATH']
  const browser = await chromium.launch(executablePath ? { executablePath } : {})
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const tile = (name: string, hue: number) =>
    `<div style="border-radius:14px;background:linear-gradient(160deg,hsl(${hue} 30% 32%),hsl(${hue} 35% 18%));display:flex;align-items:center;justify-content:center;position:relative"><div style="width:110px;height:110px;border-radius:50%;background:hsl(${hue} 40% 60%);display:flex;align-items:center;justify-content:center;font:600 40px Inter,system-ui;color:#fff">${name[0]}</div><span style="position:absolute;left:14px;bottom:12px;font:500 15px system-ui;color:#eee;background:#0008;padding:3px 9px;border-radius:8px">${name}</span></div>`
  await page.setContent(
    `<body style="margin:0;background:#1b1c1f;height:800px;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr 64px;gap:12px;padding:16px;box-sizing:border-box">${tile('Sam Rivera', 210)}${tile('Priya Shah', 150)}${tile('Jordan Lee', 30)}${tile('You', 260)}<div style="grid-column:1/3;display:flex;justify-content:center;gap:12px;align-items:center">${['Mic', 'Camera', 'Share', 'Leave'].map((x) => `<span style="font:500 13px system-ui;color:#ddd;background:${x === 'Leave' ? '#c2410c' : '#333'};padding:10px 18px;border-radius:999px">${x}</span>`).join('')}</div></body>`,
  )
  background = join(WORK, 'call.png')
  await page.screenshot({ path: background })
  await browser.close()
})

test.afterAll(async () => {
  await mock?.close()
  pulse?.stop()
  rmSync(WORK, { recursive: true, force: true })
})

async function overlayShot(overlay: Page, out: string) {
  const raw = join(WORK, `overlay-raw-${frame}.png`)
  await overlay.screenshot({ path: raw, omitBackground: true })
  // Composite the transparent overlay over the call backdrop, centred near the top.
  sh('convert', [background, raw, '-gravity', 'north', '-geometry', '+0+24', '-composite', out])
}

async function addFrame(page: Page | null, overlay?: Page, repeat = 1) {
  const file = join(WORK, `f-${frame}.png`)
  if (overlay) await overlayShot(overlay, file)
  else if (page) {
    await page.screenshot({ path: join(WORK, `main-${frame}.png`) })
    sh('convert', [
      join(WORK, `main-${frame}.png`),
      '-resize',
      '1280x800',
      '-gravity',
      'center',
      '-background',
      '#0b0b0d',
      '-extent',
      '1280x800',
      file,
    ])
  }
  for (let i = 0; i < repeat; i++) {
    sh('cp', [file, join(FRAMES, `${String(frame).padStart(4, '0')}.png`)])
    frame++
  }
}

test('capture README screenshots and demo GIF', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'bluely-shots-data-'))
  const env = {
    BLUELY_OPENROUTER_BASE_URL: mock.baseUrl,
    BLUELY_TEST_OPENROUTER_KEY: 'sk-or-demo-0123456789abcdef',
  }
  // First launch creates the schema; then seed history and relaunch.
  let { app, main } = await launch(userData, env)
  await main.evaluate(() =>
    window.bluely.invoke('settings:update', {
      patch: {
        general: { onboardingComplete: true },
        profile: { name: 'Alex Morgan', role: 'Account executive', company: 'Bluebird', about: '' },
      },
    }),
  )
  await app.close()
  seed(join(userData, 'bluely.db'))
  ;({ app, main } = await launch(userData, env))
  await expect(main.getByText('Q3 roadmap review with Acme')).toBeVisible()
  await expect(main.getByText('OpenRouter connected')).toBeVisible()
  await main.waitForTimeout(500)
  await main.screenshot({ path: join(OUT, 'main-window.png') })
  await addFrame(main, undefined, 3)

  // Settings › AI Models
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows())
      w.webContents.send('settings:open', { page: 'general' })
  })
  await main.waitForTimeout(800)
  await main.screenshot({ path: join(OUT, 'settings.png') })
  await main.keyboard.press('Escape')

  // Live session
  const overlayPromise = app.waitForEvent('window', (w) => w.url().includes('/overlay/'))
  await main.getByRole('button', { name: 'Start Bluely' }).first().click()
  const overlay = await overlayPromise
  await overlay.waitForLoadState('domcontentloaded')
  await overlay.waitForTimeout(600)
  await addFrame(null, overlay, 2)
  await overlay
    .getByRole('button', { name: /Copy disclosure message/ })
    .click()
    .catch(() => undefined)
  await overlay
    .getByRole('button', { name: /Dismiss/ })
    .first()
    .click()
    .catch(() => undefined)
  const state = await main.evaluate(() => window.bluely.invoke('session:getState', undefined))
  const sessionId = state.ok ? (state.data.sessionId as string) : ''
  await main.evaluate(
    async ({ sessionId, bytes }) => {
      const s = await window.bluely.invoke('session:getState', undefined)
      const t0 = s.ok && s.data.startedAt ? s.data.startedAt : Date.now()
      await window.bluely.invoke('audio:segment', {
        sessionId,
        channel: 'them',
        startedAt: t0 + 1200,
        endedAt: t0 + 5200,
        vadEndAt: Date.now() - 400,
        forced: false,
        wav: new Uint8Array(bytes),
      })
    },
    { sessionId, bytes: WAV },
  )
  // Capture the streaming auto-suggestion.
  await expect(overlay.getByText('Auto · they asked a question')).toBeVisible({ timeout: 15_000 })
  for (let i = 0; i < 8; i++) {
    await addFrame(null, overlay)
    await overlay.waitForTimeout(250)
  }
  await expect(overlay.getByText(/⚡/).first()).toBeVisible({ timeout: 15_000 })
  await addFrame(null, overlay, 4)
  await overlayShot(overlay, join(OUT, 'overlay.png'))

  // Assist with the screen
  await overlay.getByRole('button', { name: 'Run Assist' }).click()
  await expect(overlay.getByText('Viewed screen').last()).toBeVisible({ timeout: 15_000 })
  await overlay.waitForTimeout(2500)
  await addFrame(null, overlay, 4)

  // Stop → notes
  await overlay.getByRole('button', { name: 'Stop session' }).first().click()
  await expect(main.getByTestId('session-page')).toBeVisible({ timeout: 20_000 })
  await expect(
    main.getByTestId('session-page').getByText('Enterprise plan pricing discussion').first(),
  ).toBeVisible({ timeout: 20_000 })
  await main.waitForTimeout(400)
  await main.screenshot({ path: join(OUT, 'session-notes.png') })
  await addFrame(main, undefined, 5)
  await app.close()

  // GIF (1 frame ≈ 0.4 s), palette for crisp text.
  const palette = join(WORK, 'palette.png')
  sh('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-framerate',
    '2.5',
    '-i',
    join(FRAMES, '%04d.png'),
    '-vf',
    'scale=960:-1:flags=lanczos,palettegen=stats_mode=diff',
    palette,
  ])
  sh('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-framerate',
    '2.5',
    '-i',
    join(FRAMES, '%04d.png'),
    '-i',
    palette,
    '-lavfi',
    'scale=960:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=sierra2_4a',
    join(OUT, 'demo.gif'),
  ])
})
