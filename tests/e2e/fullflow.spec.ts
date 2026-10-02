/**
 * Full flow against the local mock OpenRouter API (no real network):
 * start → audio segments → transcription → auto-suggest → manual actions → Ask/Assist →
 * stop → notes/action items/email → search → ask across meetings.
 *
 * Audio capture is bypassed here: WAV segments are sent through the same 'audio:segment'
 * IPC the overlay uses, so the main pipeline is exercised end to end.
 */
import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
  MockOpenRouter,
  startMockOpenRouter as StartMock,
} from '../../scripts/mock-openrouter.mjs'
import { launchApp, type LaunchedApp } from './helpers'

test.describe.configure({ mode: 'serial' })

let mock: MockOpenRouter
let ctx: LaunchedApp
let main: Page
let overlay: Page
let sessionId = ''

const WAV = [...readFileSync(join(__dirname, '..', 'fixtures', 'speech-en-16k.wav'))]

async function sendSegment(channel: 'me' | 'them', offsetMs: number, durationMs: number) {
  const res = await main.evaluate(
    async ({ sessionId, channel, offsetMs, durationMs, bytes }) => {
      const state = await window.bluely.invoke('session:getState', undefined)
      if (!state.ok || !state.data.startedAt) throw new Error('no live session')
      const startedAt = state.data.startedAt + offsetMs
      const endedAt = startedAt + durationMs
      return window.bluely.invoke('audio:segment', {
        sessionId,
        channel,
        startedAt,
        endedAt,
        vadEndAt: endedAt,
        forced: false,
        wav: new Uint8Array(bytes),
      })
    },
    { sessionId, channel, offsetMs, durationMs, bytes: WAV },
  )
  expect(res).toMatchObject({ ok: true, data: { accepted: true } })
}

test.beforeAll(async () => {
  // Loaded at runtime: Playwright would otherwise transpile the ESM mock to CommonJS.
  const mockUrl = pathToFileURL(join(__dirname, '..', '..', 'scripts', 'mock-openrouter.mjs')).href
  const { startMockOpenRouter } = (await import(
    mockUrl
  )) as typeof import('../../scripts/mock-openrouter.mjs')
  mock = await startMockOpenRouter({ ttftMs: 60, tokenMs: 3, sttMs: 80 })
  ctx = await launchApp({
    BLUELY_OPENROUTER_BASE_URL: mock.baseUrl,
    BLUELY_TEST_OPENROUTER_KEY: 'sk-or-test-e2e-0123456789',
  })
  main = ctx.main
  await main.evaluate(() =>
    window.bluely.invoke('settings:update', {
      patch: { general: { onboardingComplete: true, consentReminder: true } },
    }),
  )
  await expect(main.getByTestId('home-page')).toBeVisible()
})

test.afterAll(async () => {
  await ctx?.app.close()
  await mock?.close()
})

test('main window shows the configured model and a healthy OpenRouter connection', async () => {
  await expect(main.getByText('OpenRouter connected')).toBeVisible()
})

test('Start Bluely opens the overlay with the consent reminder', async () => {
  const windowPromise = ctx.app.waitForEvent('window', (w) => w.url().includes('/overlay/'))
  await main.getByRole('button', { name: 'Start Bluely' }).first().click()
  overlay = await windowPromise
  await overlay.waitForLoadState('domcontentloaded')
  const state = await main.evaluate(() => window.bluely.invoke('session:getState', undefined))
  expect(state.ok).toBe(true)
  if (state.ok) sessionId = state.data.sessionId ?? ''
  expect(sessionId).not.toBe('')
  await expect(overlay.getByText('Let others know this call is being transcribed')).toBeVisible()
})

test('a Them question is transcribed and triggers an automatic suggestion', async () => {
  await sendSegment('them', 1000, 4000)
  await overlay.getByRole('tab', { name: 'Transcript' }).click()
  await expect(
    overlay.getByText(/What does the enterprise plan cost per seat\?/).first(),
  ).toBeVisible()
  await overlay.getByRole('tab', { name: 'Insights' }).click()
  await expect(overlay.getByText('Auto · they asked a question')).toBeVisible({ timeout: 15_000 })
  await expect(
    overlay.getByText(/The enterprise plan starts at a per-seat price/).first(),
  ).toBeVisible()
  await expect(
    overlay.getByText(/⚡ .* to first word · .* total · .* tok\/s · groq/).first(),
  ).toBeVisible()
})

test('one-click action streams an answer with the speed readout', async () => {
  await overlay
    .getByRole('button', { name: /Follow-up questions/ })
    .first()
    .click()
  await expect(
    overlay.getByText(/Which manual process takes your team the most time/).first(),
  ).toBeVisible()
  await expect(overlay.getByText(/⚡ .*tok\/s/)).toHaveCount(2)
})

test('typed question and Assist with the screen', async () => {
  const input = overlay.getByRole('textbox', { name: 'Ask about your screen or conversation' })
  await input.fill('What should I ask about their budget?')
  await input.press('Enter')
  await expect(overlay.getByText('What should I ask about their budget?').first()).toBeVisible()
  await overlay.getByRole('button', { name: 'Run Assist' }).click()
  await expect(overlay.getByText('Viewed screen').last()).toBeVisible({ timeout: 15_000 })
  await expect(overlay.getByText('I can see your screen').last()).toBeVisible()
})

test('stop generates notes, action items and the follow-up email', async () => {
  await sendSegment('me', 6000, 3000)
  await overlay.getByRole('button', { name: 'Stop session' }).first().click()
  await expect(main.getByTestId('session-page')).toBeVisible({ timeout: 20_000 })
  const page = main.getByTestId('session-page')
  await expect(page.getByText('Enterprise plan pricing discussion').first()).toBeVisible({
    timeout: 20_000,
  })
  await expect(page.getByText('Move forward with a pilot for the ops team')).toBeVisible()
  await main.getByRole('tab', { name: /Action items/ }).click()
  await expect(page.getByText('Send the enterprise pricing sheet')).toBeVisible()
  await main.getByRole('tab', { name: 'Follow-up email' }).click()
  await expect(page.getByRole('textbox').first()).toHaveValue('Great speaking today: next steps')
  await main.getByRole('tab', { name: 'Transcript' }).click()
  await expect(page.getByText(/enterprise plan cost per seat/).first()).toBeVisible()
})

test('search finds the meeting and Ask Bluely answers across meetings', async () => {
  const search = main.getByRole('searchbox', { name: 'Search or ask about your meetings' })
  await search.fill('enterprise')
  await expect(main.getByTestId('search-results')).toBeVisible()
  await expect(main.getByTestId('search-group').first()).toContainText(
    'Enterprise plan pricing discussion',
  )
  await search.fill('What did they ask about the enterprise plan?')
  const ask = main.getByTestId('ask-across')
  await expect(ask).toBeVisible()
  await ask.click()
  await expect(main.getByTestId('answer-card').first()).toContainText('⚡', { timeout: 15_000 })
})

test('OpenRouter requests carry attribution, routing and STT parameters', async () => {
  const chats = mock.requests.filter((r) => r.path === '/chat/completions')
  expect(chats.length).toBeGreaterThanOrEqual(6)
  for (const r of chats) {
    expect(r.headers.referer).toBe('https://github.com/nakib-abrar/bluely')
    expect(r.headers.title).toBe('Bluely')
    const body = r.body as { model: string; stream: boolean; provider?: { sort?: string } }
    expect(body.model.endsWith(':nitro')).toBe(false)
    expect(body.stream).toBe(true)
  }
  const live = chats.find(
    (r) => (r.body as { model: string }).model === 'meta-llama/llama-3.3-70b-instruct',
  )
  expect((live?.body as { provider?: { sort?: string; order?: string[] } }).provider).toMatchObject(
    {
      sort: 'latency',
      order: ['groq', 'cerebras'],
    },
  )
  const stt = mock.requests.filter((r) => r.path === '/audio/transcriptions')
  expect(stt.length).toBe(2)
  for (const r of stt) {
    const body = r.body as { model: string; language?: string; input_audio: { format: string } }
    expect(body.model).toBe('openai/whisper-large-v3-turbo')
    expect(body.language).toBeUndefined()
    expect(body.input_audio.format).toBe('wav')
  }
})
