/**
 * Real capture end to end: speech played on the PC's speakers is captured through desktop
 * loopback ("Them"), cut by the Silero VAD, transcribed (mock OpenRouter) and triggers an
 * automatic suggestion. Measures the auto-suggest latency stages. Runs on Linux (private
 * PulseAudio) and on Windows with BLUELY_E2E_AUDIO=1 (see ./speakers.ts).
 */
import { expect, test, type Page } from '@playwright/test'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { LatencyTrace } from '@shared/types'
import type {
  MockOpenRouter,
  startMockOpenRouter as StartMock,
} from '../../scripts/mock-openrouter.mjs'
import { launchApp, type LaunchedApp } from './helpers'
import { openSpeakers, speakersUnavailableReason, type Speakers } from './speakers'

test.describe.configure({ mode: 'serial' })
const unavailable = speakersUnavailableReason()
test.skip(unavailable !== null, unavailable ?? '')

const SPEECH = join(__dirname, '..', 'fixtures', 'speech-en-48k.wav')
const QUESTION = 'Thanks for joining. What does the enterprise plan cost per seat?'
let speakers: Speakers | null = null
let mock: MockOpenRouter
let ctx: LaunchedApp
let main: Page
let overlay: Page

test.beforeAll(async () => {
  speakers = openSpeakers()
  test.skip(!speakers, 'Could not open the test speakers (PulseAudio daemon)')
  // The mock hands out scripted lines in order; when the mic hears an echo of the speakers its
  // segment could take the question line, so pin every transcription to the question (the echo
  // Me line is then dropped by the de-duplicator).
  if (speakers!.micHearsSpeakers) process.env['MOCK_STT_TEXT'] = QUESTION
  const mockUrl = pathToFileURL(join(__dirname, '..', '..', 'scripts', 'mock-openrouter.mjs')).href
  const { startMockOpenRouter } = (await import(mockUrl)) as {
    startMockOpenRouter: typeof StartMock
  }
  // Latencies in the range of a fast provider (Groq-hosted Whisper / Llama).
  mock = await startMockOpenRouter({ ttftMs: 250, tokenMs: 8, sttMs: 350 })
  ctx = await launchApp({
    BLUELY_OPENROUTER_BASE_URL: mock.baseUrl,
    BLUELY_TEST_OPENROUTER_KEY: 'sk-or-test-live-0123456789',
    ...speakers!.appEnv,
  })
  main = ctx.main
  await main.evaluate(() =>
    window.bluely.invoke('settings:update', { patch: { general: { onboardingComplete: true } } }),
  )
  await main.evaluate(() => {
    const w = window as unknown as { __traces: LatencyTrace[] }
    w.__traces = []
    window.bluely.on('dev:latency', (t) => w.__traces.push(t))
  })
})

test.afterAll(async () => {
  await ctx?.app.close()
  await mock?.close()
  speakers?.close()
  delete process.env['MOCK_STT_TEXT']
})

test('capture goes live on the loopback channel', async () => {
  const windowPromise = ctx.app.waitForEvent('window', (w) => w.url().includes('/overlay/'))
  await main.getByRole('button', { name: 'Start Bluely' }).first().click()
  overlay = await windowPromise
  await expect
    .poll(
      async () => {
        const s = await main.evaluate(() => window.bluely.invoke('session:getState', undefined))
        return s.ok ? `${s.data.status}/${s.data.audio.them.state}` : 'error'
      },
      { timeout: 20_000 },
    )
    .toBe('live/listening')
})

test('speech on the speakers becomes a Them line and an automatic suggestion', async () => {
  const player = speakers!.play(SPEECH)
  await overlay.getByRole('tab', { name: 'Transcript' }).click()
  await expect(
    overlay.getByText(/What does the enterprise plan cost per seat\?/).first(),
  ).toBeVisible({
    timeout: 30_000,
  })
  await overlay.getByRole('tab', { name: 'Insights' }).click()
  await expect(overlay.getByText('Auto · they asked a question')).toBeVisible({ timeout: 15_000 })
  await expect(overlay.getByText(/⚡ .* to first word/).first()).toBeVisible()
  player.kill()

  const traces = (await main.evaluate(
    () => (window as unknown as { __traces: LatencyTrace[] }).__traces,
  )) as LatencyTrace[]
  const auto = traces.find((t) => t.kind === 'auto')
  expect(auto).toBeTruthy()
  const ms = (a: number | null | undefined, b: number | null | undefined) =>
    a != null && b != null ? b - a : null
  const stages = {
    vadEndToStt: ms(auto!.vadEndAt, auto!.sttDoneAt),
    sttToPrompt: ms(auto!.sttDoneAt, auto!.promptBuiltAt),
    promptToFirstToken: ms(auto!.promptBuiltAt, auto!.firstTokenAt),
    vadEndToFirstToken: ms(auto!.vadEndAt, auto!.firstTokenAt),
  }
  console.log(`[live e2e] auto-suggest latency stages (ms): ${JSON.stringify(stages)}`)
  expect(stages.vadEndToFirstToken).not.toBeNull()
})

test('stopping produces notes for the captured call', async () => {
  await overlay.getByRole('button', { name: 'Stop session' }).first().click()
  const page = main.getByTestId('session-page')
  await expect(page).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('Enterprise plan pricing discussion').first()).toBeVisible({
    timeout: 30_000,
  })
})
