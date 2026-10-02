/**
 * Overlay UI: drives the real overlay window with a faked live-session backend.
 *
 * The main-side session/AI handlers are built by other slices, so this spec replaces their
 * IPC handlers from the main process (recording every call) and pushes the events main
 * would send. Set OVERLAYUI_SHOTS_DIR to also save screenshots of every state.
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { EventChannel, EventPayload } from '../../src/shared/ipc'
import type { AiCard, LatencyTrace, LiveSessionState, TranscriptLine } from '../../src/shared/types'
import { launchApp, type LaunchedApp } from './helpers'

const SESSION = 'sess-e2e-1'
const STARTED_AT = Date.now() - (12 * 60 + 4) * 1000
const SHOTS = process.env['OVERLAYUI_SHOTS_DIR'] ?? null

let ctx: LaunchedApp
let overlay: Page

interface Call {
  channel: string
  payload: unknown
}

/** Replaces a main-process IPC handler with one that records calls and returns `data`. */
async function fake(app: ElectronApplication, channel: string, data: unknown): Promise<void> {
  await app.evaluate(
    ({ ipcMain }, arg) => {
      const g = globalThis as unknown as { __calls?: { channel: string; payload: unknown }[] }
      g.__calls ??= []
      ipcMain.removeHandler(arg.channel)
      ipcMain.handle(arg.channel, (_e, payload: unknown) => {
        g.__calls?.push({ channel: arg.channel, payload })
        return { ok: true, data: arg.data }
      })
    },
    { channel, data },
  )
}

async function calls(channel: string): Promise<unknown[]> {
  const all = await ctx.app.evaluate(
    () => (globalThis as unknown as { __calls?: Call[] }).__calls ?? [],
  )
  return all.filter((c) => c.channel === channel).map((c) => c.payload)
}

async function clearCalls(): Promise<void> {
  await ctx.app.evaluate(() => {
    ;(globalThis as unknown as { __calls?: Call[] }).__calls = []
  })
}

/** Sends a main → renderer event to every window, like the EventBus does. */
async function emit<E extends EventChannel>(event: E, payload: EventPayload<E>): Promise<void> {
  await ctx.app.evaluate(
    ({ BrowserWindow }, arg) => {
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send(arg.event, arg.payload)
    },
    { event, payload },
  )
}

function liveState(patch: Partial<LiveSessionState> = {}): LiveSessionState {
  return {
    status: 'live',
    sessionId: SESSION,
    startedAt: STARTED_AT,
    modeId: 'builtin-general',
    audio: { me: { state: 'listening', error: null }, them: { state: 'listening', error: null } },
    warnings: [],
    autoSuggest: true,
    showConsentReminder: false,
    lastError: null,
    ...patch,
  }
}

let createdAt = Date.now()
function card(patch: Partial<AiCard> & Pick<AiCard, 'id' | 'kind'>): AiCard {
  createdAt += 1000
  return {
    scope: 'live',
    sessionId: SESSION,
    label: '',
    question: null,
    usedScreen: false,
    tier: 'smart',
    status: 'streaming',
    text: '',
    error: null,
    stats: null,
    citations: [],
    createdAt,
    ...patch,
  }
}

function line(id: string, channel: 'me' | 'them', startSec: number, text: string, isFinal = true) {
  return {
    id,
    sessionId: SESSION,
    channel,
    startMs: startSec * 1000,
    endMs: startSec * 1000 + 3000,
    text,
    isFinal,
  } satisfies TranscriptLine
}

const STATS = {
  ttftMs: 420,
  totalMs: 1900,
  tokensPerSec: 186,
  tokensIn: 1200,
  tokensOut: 96,
  costUsd: 0.0004,
  provider: 'Groq',
  model: 'meta-llama/llama-3.3-70b-instruct',
  generationId: 'gen-1',
}

async function setTheme(theme: 'dark' | 'light'): Promise<void> {
  await ctx.main.evaluate(
    (th) => window.bluely.invoke('settings:update', { patch: { general: { theme: th } } }),
    theme,
  )
  await expect(overlay.locator('html')).toHaveAttribute('data-theme', theme)
}

/** Saves a screenshot over a desktop-like backdrop (the overlay itself is transparent). */
async function shot(name: string): Promise<void> {
  if (!SHOTS) return
  mkdirSync(SHOTS, { recursive: true })
  const theme = await overlay.locator('html').getAttribute('data-theme')
  await overlay.evaluate((th) => {
    const style = document.createElement('style')
    style.id = 'ov-shot-backdrop'
    style.textContent =
      th === 'light'
        ? 'html.ov-shot{background:linear-gradient(160deg,#3a3f4b,#1f2229)!important}'
        : 'html.ov-shot{background:repeating-linear-gradient(180deg,#fafafa 0 22px,#ececec 22px 23px)!important}'
    document.head.appendChild(style)
    document.documentElement.classList.add('ov-shot')
  }, theme)
  await overlay.waitForTimeout(250)
  await overlay.screenshot({ path: join(SHOTS, `${name}-${theme}.png`) })
  await overlay.evaluate(() => {
    document.getElementById('ov-shot-backdrop')?.remove()
    document.documentElement.classList.remove('ov-shot')
  })
}

async function shotBothThemes(name: string): Promise<void> {
  if (!SHOTS) return
  await shot(name)
  await setTheme('light')
  await shot(name)
  await setTheme('dark')
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  ctx = await launchApp()
  const { app } = ctx
  await fake(app, 'session:getState', liveState({ status: 'idle', sessionId: null }))
  await fake(app, 'session:getTranscript', [])
  await fake(app, 'ai:getCards', [])
  await fake(app, 'ai:run', { id: 'run-1' })
  await fake(app, 'ai:cancel', null)
  await fake(app, 'ai:clear', null)
  await fake(app, 'session:stop', null)
  await fake(app, 'session:start', { sessionId: SESSION })
  await fake(app, 'session:dismissConsent', null)
  await fake(app, 'session:setAutoSuggest', null)
  await fake(app, 'audio:stopped', null)
  await fake(app, 'modes:setActive', null)
  await fake(app, 'app:openMainWindow', null)
  await fake(app, 'app:openSettings', null)
  await fake(app, 'clipboard:writeText', null)
  await ctx.main.waitForLoadState('domcontentloaded')
  await ctx.main.evaluate(() => window.bluely.invoke('overlay:setVisible', { visible: true }))
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const found = ctx.app.windows().find((w) => w.url().endsWith('/overlay/index.html'))
    if (found) {
      overlay = found
      break
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  expect(overlay, 'overlay window opened').toBeTruthy()
  await overlay.waitForLoadState('domcontentloaded')
  await expect(overlay.getByRole('button', { name: 'Start Bluely' })).toBeVisible()
})

test.afterAll(async () => {
  await ctx?.app.close()
})

test('idle overlay: pill with Start, panel with idle hint, transparent root', async () => {
  await expect(overlay.getByText('Not in a session')).toBeVisible()
  const bg = await overlay.evaluate(() => getComputedStyle(document.body).backgroundColor)
  expect(bg).toBe('rgba(0, 0, 0, 0)')
  await overlay.getByRole('button', { name: 'Start Bluely' }).click()
  await expect.poll(() => calls('session:start')).toHaveLength(1)
  await shotBothThemes('00-idle')
})

test('live session: timer, meters, warnings and consent reminder', async () => {
  await emit(
    'session:state',
    liveState({
      showConsentReminder: true,
      warnings: ['no_system_audio', 'stt_error_retrying', 'use_headphones'],
    }),
  )
  await expect(overlay.getByText(/^12:\d\d$/)).toBeVisible()
  await expect(overlay.getByRole('img', { name: /Audio activity/ })).toBeVisible()
  await expect(overlay.getByText('Let others know this call is being transcribed')).toBeVisible()
  await expect(overlay.locator('[data-warning="no_system_audio"]')).toContainText(
    'No system audio detected',
  )
  await expect(overlay.locator('[data-warning="stt_error_retrying"]')).toBeVisible()
  await expect(
    overlay.getByText('Bluely will suggest replies when they ask a question.'),
  ).toBeVisible()
  // Fake some audio activity for the screenshot (no real audio devices in CI).
  await overlay.evaluate(() => {
    const fills = document.querySelectorAll<HTMLElement>('.ov-meter-fill')
    fills[0]?.style.setProperty('transform', 'scaleY(0.85)')
    fills[1]?.style.setProperty('transform', 'scaleY(0.45)')
  })
  await shotBothThemes('01-live-empty-warnings')

  await overlay.getByRole('button', { name: 'Copy disclosure message' }).click()
  await expect
    .poll(() => calls('clipboard:writeText'))
    .toEqual([{ text: "Heads up: I'm using an AI note-taker (Bluely) to transcribe this call." }])
  await overlay.getByRole('button', { name: 'Dismiss reminder' }).click()
  await expect.poll(() => calls('session:dismissConsent')).toHaveLength(1)
  await expect(overlay.getByText('Let others know this call is being transcribed')).toBeHidden()

  await emit('session:state', liveState({ warnings: ['no_key'] }))
  await overlay.getByRole('button', { name: 'Add key' }).click()
  await expect.poll(() => calls('app:openSettings')).toEqual([{ page: 'models' }])
  await emit('session:state', liveState())
})

test('answer cards stream in with labels, viewed screen, stats, cancel and retry', async () => {
  await emit(
    'session:state',
    liveState({ status: 'live', warnings: [], showConsentReminder: false }),
  )
  await emit('ai:card', card({ id: 'c-assist', kind: 'assist', label: 'Assist', usedScreen: true }))
  const assist = overlay.locator('[data-card-id="c-assist"]')
  await expect(assist.getByText('Thinking')).toBeVisible()
  const answer =
    '> “Once we’ve addressed your privacy concerns, which manual process is taking the most time for your team?”'
  for (const part of answer.match(/.{1,12}/g) ?? [])
    await emit('ai:delta', { id: 'c-assist', delta: part })
  await expect(assist).toContainText('which manual process')
  await expect(assist.getByRole('button', { name: 'Stop' })).toBeVisible()
  await emit('ai:done', { id: 'c-assist', text: answer, stats: STATS })
  await expect(assist).toHaveAttribute('data-status', 'done')
  await expect(assist.getByText('Viewed screen')).toBeVisible()
  await expect(assist).toContainText('0.42 s to first word')
  await expect(assist.getByRole('button', { name: 'Copy' })).toBeVisible()
  await shotBothThemes('02-assist-answer')

  await emit(
    'ai:card',
    card({
      id: 'c-ask',
      kind: 'ask',
      label: 'How should I price the pilot?',
      question: 'How should I price the pilot?',
      status: 'done',
      text: 'Offer a **4-week pilot** at a fixed fee, credited toward the annual plan if they convert.\n\n- Anchor on the time saved per week\n- Keep scope to one team',
      stats: { ...STATS, ttftMs: 610, totalMs: 2400 },
    }),
  )
  await emit('ai:card', card({ id: 'c-auto', kind: 'auto', label: 'Auto · they asked a question' }))
  await emit('ai:delta', { id: 'c-auto', delta: 'Mostly the weekly reporting: it takes ' })
  await emit('ai:delta', { id: 'c-auto', delta: 'two people most of Friday.' })
  const auto = overlay.locator('[data-card-id="c-auto"]')
  await expect(auto).toContainText('two people most of Friday.')
  await expect(auto.getByText('Auto · they asked a question')).toBeVisible()
  // Following the stream: the newest card is in view and no "Jump to latest" pill shows.
  const jump = overlay.getByRole('button', { name: 'Jump to latest' })
  await expect(auto).toBeInViewport()
  await expect(jump).toHaveCount(0)
  await shotBothThemes('02-cards-streaming')
  await overlay.locator('[data-list="insights"]').hover()
  await overlay.mouse.wheel(0, -600)
  await expect(jump).toBeVisible()
  await emit('ai:delta', { id: 'c-auto', delta: ' And approvals.' })
  await expect(auto).not.toBeInViewport()
  await jump.click()
  await expect(jump).toBeHidden()
  await expect(auto).toBeInViewport()

  await auto.getByRole('button', { name: 'Stop' }).click()
  await expect.poll(() => calls('ai:cancel')).toEqual([{ id: 'c-auto' }])
  await emit('ai:cancelled', { id: 'c-auto' })
  await expect(auto).toHaveAttribute('data-status', 'cancelled')

  await emit('ai:card', card({ id: 'c-err', kind: 'followups', label: 'Follow-up questions' }))
  await emit('ai:error', {
    id: 'c-err',
    error: {
      code: 'rate_limit',
      message: 'OpenRouter is rate limiting requests.',
      retryable: true,
    },
  })
  const failed = overlay.locator('[data-card-id="c-err"]')
  await expect(failed).toContainText('OpenRouter is rate limiting requests.')
  await shotBothThemes('03-cards-error')
  await clearCalls()
  await failed.getByRole('button', { name: 'Retry' }).click()
  await expect.poll(() => calls('ai:run')).toEqual([{ kind: 'followups' }])
  await expect(failed).toBeHidden()
})

test('action row, Assist and typed questions send the right ai:run payloads', async () => {
  await clearCalls()
  const row = overlay.getByRole('toolbar', { name: 'Quick actions' })
  await row.getByRole('button', { name: 'Assist' }).click()
  await row.getByRole('button', { name: 'What should I say?' }).click()
  await row.getByRole('button', { name: 'Follow-up questions' }).click()
  await row.getByRole('button', { name: 'Recap' }).click()
  await row.getByRole('button', { name: 'More actions' }).click()
  await overlay.getByRole('menuitem', { name: 'Fact check' }).click()
  await row.getByRole('button', { name: 'More actions' }).click()
  await overlay.getByRole('menuitem', { name: 'Who am I talking to?' }).click()
  await expect
    .poll(() => calls('ai:run'))
    .toEqual([
      { kind: 'assist', includeScreen: true, tier: 'smart' },
      { kind: 'say' },
      { kind: 'followups' },
      { kind: 'recap' },
      { kind: 'factcheck' },
      { kind: 'who' },
    ])

  await clearCalls()
  const input = overlay.getByRole('textbox', { name: 'Ask about your screen or conversation' })
  await input.fill('What did they say about budget?')
  await input.press('Enter')
  await expect
    .poll(() => calls('ai:run'))
    .toEqual([
      {
        kind: 'ask',
        question: 'What did they say about budget?',
        includeScreen: false,
        tier: 'smart',
      },
    ])
  await expect(input).toHaveValue('')

  // The eye edits the toggle for the current input: typed text → questions.
  await clearCalls()
  await input.fill('Summarize the slide')
  await overlay.getByRole('button', { name: /question won’t include your screen/ }).click()
  await overlay.getByRole('button', { name: 'Send question' }).click()
  // Tier chip → Fast; empty input + send = Assist (screen still on for Assist).
  await overlay.getByRole('button', { name: 'Smart' }).click()
  await expect(overlay.getByRole('button', { name: 'Fast' })).toBeVisible()
  await overlay.getByRole('button', { name: 'Run Assist' }).click()
  await expect
    .poll(() => calls('ai:run'))
    .toEqual([
      { kind: 'ask', question: 'Summarize the slide', includeScreen: true, tier: 'smart' },
      { kind: 'assist', includeScreen: true, tier: 'fast' },
    ])
  await overlay.getByRole('button', { name: 'Fast' }).click()
  await expect(overlay.getByRole('button', { name: 'Smart' })).toBeVisible()

  // Ctrl+Enter with text asks it; with an empty input it runs Assist.
  await clearCalls()
  await input.fill('Is that within budget?')
  await input.press('Control+Enter')
  await input.press('Control+Enter')
  await expect
    .poll(() => calls('ai:run'))
    .toEqual([
      { kind: 'ask', question: 'Is that within budget?', includeScreen: true, tier: 'smart' },
      { kind: 'assist', includeScreen: true, tier: 'smart' },
    ])

  // Global shortcut commands from main.
  await clearCalls()
  await emit('overlay:command', { type: 'action', action: 'recap' })
  await expect.poll(() => calls('ai:run')).toEqual([{ kind: 'recap' }])
  await emit('overlay:command', { type: 'setTab', tab: 'transcript' })
  await expect(overlay.getByRole('tab', { name: 'Transcript' })).toHaveAttribute(
    'data-state',
    'active',
  )
  await emit('overlay:command', { type: 'setTab', tab: 'insights' })
  await input.blur()
  await emit('overlay:command', { type: 'focusInput' })
  await expect(input).toBeFocused()
  await input.fill('typed before the shortcut')
  // Outside the local/global de-duplication window of the earlier local Ctrl+Enter.
  await overlay.waitForTimeout(300)
  await emit('overlay:command', { type: 'assist' })
  await expect
    .poll(() => calls('ai:run'))
    .toContainEqual({
      kind: 'ask',
      question: 'typed before the shortcut',
      includeScreen: true,
      tier: 'smart',
    })
})

test('“…” menu: keybinds, widget toggle, modes, main window and settings', async () => {
  await overlay.getByRole('button', { name: 'More options' }).click()
  const menu = overlay.getByRole('menu')
  await expect(menu.getByText('Keybinds')).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: /Show\/hide Bluely/ })).toContainText('Ctrl')
  await expect(menu.getByRole('menuitem', { name: /Clear chat/ })).toContainText('R')
  await expect(menu.getByRole('menuitem', { name: /Move Bluely/ })).toContainText('↑↓←→')
  await expect(menu.getByText('Hide Bluely hides widget')).toBeVisible()
  await expect(menu.getByText(/undetect/i)).toHaveCount(0)
  await menu.getByRole('menuitem', { name: 'Modes' }).hover()
  await expect(overlay.getByRole('menuitemradio', { name: /Sales call/ })).toBeVisible()
  await shotBothThemesWithMenu()
  await overlay.getByRole('menuitemradio', { name: /Sales call/ }).click()
  await expect.poll(() => calls('modes:setActive')).toEqual([{ id: 'builtin-sales' }])
  await expect(overlay.getByTitle(/Active mode: Sales call/)).toBeVisible()

  await overlay.getByRole('button', { name: 'More options' }).click()
  await overlay.getByRole('menuitem', { name: 'Hide Bluely hides widget' }).click()
  await expect
    .poll(() =>
      ctx.main.evaluate(async () => {
        const res = await window.bluely.invoke('settings:get', undefined)
        return res.ok ? res.data.general.hideHidesWidget : null
      }),
    )
    .toBe(true)
  await overlay.keyboard.press('Escape')

  await overlay.getByRole('button', { name: 'More options' }).click()
  await overlay.getByRole('menuitem', { name: 'Open Bluely window' }).click()
  await overlay.getByRole('button', { name: 'More options' }).click()
  await overlay.getByRole('menuitem', { name: 'Settings' }).click()
  await expect.poll(() => calls('app:openMainWindow')).toEqual([{}])
  await expect.poll(() => calls('app:openSettings')).toContainEqual({})
  // Restore the default for later tests.
  await ctx.main.evaluate(() =>
    window.bluely.invoke('settings:update', { patch: { general: { hideHidesWidget: false } } }),
  )
})

async function shotBothThemesWithMenu(): Promise<void> {
  if (!SHOTS) return
  await shot('04-menu')
  await overlay.keyboard.press('Escape')
  await overlay.keyboard.press('Escape')
  await setTheme('light')
  await overlay.getByRole('button', { name: 'More options' }).click()
  await overlay.getByRole('menu').getByRole('menuitem', { name: 'Modes' }).hover()
  await expect(overlay.getByRole('menuitemradio', { name: /Sales call/ })).toBeVisible()
  await shot('04-menu')
  await overlay.keyboard.press('Escape')
  await overlay.keyboard.press('Escape')
  await setTheme('dark')
  await overlay.getByRole('button', { name: 'More options' }).click()
  await overlay.getByRole('menu').getByRole('menuitem', { name: 'Modes' }).hover()
}

test('transcript tab shows speaker-labelled live lines', async () => {
  const lines = [
    line('l1', 'them', 3, 'Thanks for making the time today.'),
    line('l2', 'me', 6, 'Of course, happy to walk you through it.'),
    line(
      'l3',
      'them',
      12,
      'Which part are you unsure about: what it can automate, or the investment?',
    ),
    line('l4', 'them', 18, 'We mostly care about the reporting piece.'),
  ]
  for (const l of lines) await emit('transcript:line', l)
  await emit('transcript:line', line('l5', 'me', 24, 'Got it, so the weekly', false))
  await overlay.getByRole('tab', { name: 'Transcript' }).click()
  const view = overlay.locator('[data-list="transcript"]')
  await expect(view).toContainText('We mostly care about the reporting piece.')
  await expect(view.locator('[data-line-id="l5"] p')).toHaveClass(/italic/)
  // partial → final replaces the text in place.
  await emit('transcript:line', line('l5', 'me', 24, 'Got it, so the weekly report is the pain.'))
  await expect(view.locator('[data-line-id="l5"] p')).toHaveText(
    'Got it, so the weekly report is the pain.',
  )
  await expect(view.locator('[data-line-id="l5"] p')).not.toHaveClass(/italic/)
  await expect(view.getByText('00:12')).toBeVisible()
  await emit('transcript:line', line('l6', 'them', 30, 'Exactly, and the approvals.', false))
  await shotBothThemes('05-transcript')
  await emit('transcript:remove', { id: 'l6', sessionId: SESSION })
  await expect(view.locator('[data-line-id="l6"]')).toHaveCount(0)

  // A new answer while on Transcript shows an unseen badge on Insights.
  await emit('ai:card', card({ id: 'c-badge', kind: 'recap', status: 'done', text: 'Recap.' }))
  await expect(overlay.getByRole('tab', { name: /Insights/ })).toContainText('1')
  await overlay.getByRole('tab', { name: /Insights/ }).click()
  await expect(overlay.locator('[data-card-id="c-badge"]')).toBeVisible()
})

test('local keybinds: clear chat and the latency dev panel', async () => {
  await clearCalls()
  await overlay.locator('[data-list="insights"]').click({ position: { x: 5, y: 5 } })
  await overlay.keyboard.press('Control+r')
  await expect.poll(() => calls('ai:clear')).toHaveLength(1)
  await expect(overlay.locator('[data-card-id]')).toHaveCount(0)

  await overlay.keyboard.press('Control+Shift+D')
  await expect(overlay.getByText('No requests yet.', { exact: false })).toBeVisible()
  const base = Date.now()
  const traces: LatencyTrace[] = [
    {
      id: 't1',
      kind: 'auto',
      model: 'meta-llama/llama-3.3-70b-instruct',
      vadEndAt: base,
      sttDoneAt: base + 380,
      promptBuiltAt: base + 395,
      requestSentAt: base + 400,
      firstTokenAt: base + 820,
      doneAt: base + 1900,
      promptTokensEstimate: 1830,
    },
    {
      id: 't2',
      kind: 'assist',
      model: 'google/gemini-2.5-flash',
      vadEndAt: null,
      sttDoneAt: null,
      promptBuiltAt: base + 10,
      requestSentAt: base + 900,
      firstTokenAt: base + 2600,
      doneAt: base + 4000,
      promptTokensEstimate: 2400,
    },
  ]
  for (const tr of traces) await emit('dev:latency', tr)
  await expect(overlay.locator('[data-trace="t1"]')).toContainText('0.82')
  await expect(overlay.locator('[data-trace="t2"] [data-slow="true"]')).toHaveText('2.59')
  await emit(
    'ai:card',
    card({
      id: 'c-after',
      kind: 'say',
      status: 'done',
      text: 'Ask about their timeline.',
      stats: STATS,
    }),
  )
  await shotBothThemes('06-dev-panel')
  await emit('overlay:command', { type: 'toggleDevPanel' })
  await expect(overlay.getByRole('region', { name: 'Latency' })).toBeHidden()
})

test('collapse to the pill and expand again; window hugs the content', async () => {
  const height = () =>
    ctx.app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() === 'Bluely overlay')
      return w?.getBounds().height ?? 0
    })
  await expect.poll(height).toBeGreaterThan(400)
  await overlay.getByRole('button', { name: 'Hide', exact: true }).click()
  await expect(overlay.getByRole('region', { name: 'Bluely live panel' })).toBeHidden()
  await expect.poll(height).toBeLessThan(90)
  await shotBothThemes('07-collapsed')
  await overlay.getByRole('button', { name: 'Show', exact: true }).click()
  await expect(overlay.getByRole('region', { name: 'Bluely live panel' })).toBeVisible()
  await expect.poll(height).toBeGreaterThan(400)
})

test('stop: Stop button calls session:stop and stopping stops capture', async () => {
  await clearCalls()
  await overlay.getByRole('button', { name: 'Stop session' }).click()
  await expect.poll(() => calls('session:stop')).toHaveLength(1)
  await emit('session:state', liveState({ status: 'stopping' }))
  await expect(overlay.locator('[data-status="stopping"]')).toBeVisible()
  await expect(overlay.locator('[aria-live="polite"]', { hasText: 'Stopping…' })).toHaveCount(1)
  await expect(overlay.getByRole('button', { name: 'Stop session' })).toBeDisabled()
  // Stopping capture completes the stop handshake.
  await expect.poll(() => calls('audio:stopped')).toEqual([{ sessionId: SESSION }])
  await emit('session:state', liveState({ status: 'idle', sessionId: null, startedAt: null }))
  await expect(overlay.getByRole('button', { name: 'Start Bluely' })).toBeVisible()
})
