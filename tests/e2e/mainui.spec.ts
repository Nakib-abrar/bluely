/**
 * Main window UI (slice `mainui`). The backend is faked from the main process: every
 * channel the main window uses is replaced with an in-memory handler, and ai:* / session
 * events are pushed the way the real features will push them.
 *
 * Set MAINUI_SHOTS_DIR to also save screenshots of every state (dark + light).
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type {
  ActionItem,
  AiCard,
  KeyStatus,
  LiveSessionState,
  Mode,
  Notice,
  SessionDetail,
  SessionSummary,
  SpeedStats,
} from '../../src/shared/types'
import { launchApp, type LaunchedApp } from './helpers'

const SHOTS = process.env['MAINUI_SHOTS_DIR']

// ───────────────────────────── fixture data ─────────────────────────────

function at(daysAgo: number, h: number, m: number): number {
  const d = new Date()
  d.setDate(d.getDate() - daysAgo)
  d.setHours(h, m, 0, 0)
  return d.getTime()
}

function summary(
  id: string,
  title: string,
  startedAt: number,
  durationMs: number | null,
  status: SessionSummary['status'] = 'done',
): SessionSummary {
  return {
    id,
    title,
    modeId: 'builtin-sales',
    startedAt,
    endedAt: durationMs == null ? null : startedAt + durationMs,
    durationMs,
    status,
  }
}

const SESSIONS: SessionSummary[] = [
  summary('s1', 'Q3 roadmap review with Acme', at(0, 10, 4), 5_255_000),
  summary('s2', 'Customer discovery: Northwind Traders', at(0, 8, 31), 1_751_000, 'processing'),
  summary('s3', 'Weekly design sync', at(1, 15, 2), 2_412_000),
  summary('s4', 'Pricing call with Globex', at(1, 11, 45), 3_105_000),
  summary('s5', 'Interview practice: system design', at(1, 9, 12), 1_383_000, 'recovered'),
  summary('s6', 'Investor update with Lakeside Ventures', at(4, 16, 20), 2_801_000, 'failed'),
  summary('s7', '', at(4, 13, 5), 63_000),
  summary('s8', 'Onboarding call with Initech', at(9, 14, 40), 1_984_000),
]

const ACTIONS: ActionItem[] = [
  {
    id: 'a1',
    sessionId: 's1',
    text: 'Send Acme the revised Q3 timeline with the analytics milestone moved to August',
    owner: 'Priya',
    due: 'Friday',
    done: false,
  },
  {
    id: 'a2',
    sessionId: 's1',
    text: 'Share the SSO security questionnaire with their IT lead',
    owner: 'Me',
    due: null,
    done: false,
  },
  {
    id: 'a3',
    sessionId: 's1',
    text: 'Book a follow-up demo for the reporting dashboard',
    owner: null,
    due: 'Next week',
    done: true,
  },
]

function line(
  i: number,
  channel: 'me' | 'them',
  startMs: number,
  text: string,
): SessionDetail['transcript'][number] {
  return {
    id: `l${i}`,
    sessionId: 's1',
    channel,
    startMs,
    endMs: startMs + 4000,
    text,
    isFinal: true,
  }
}

const TRANSCRIPT = [
  line(
    1,
    'me',
    4_000,
    'Thanks for making the time today. I wanted to walk through the Q3 roadmap.',
  ),
  line(
    2,
    'them',
    11_000,
    'Great. Our main concern is the analytics milestone, it slipped twice last year.',
  ),
  line(3, 'me', 19_000, 'Understood. We moved it to August and staffed a dedicated team for it.'),
  line(4, 'them', 27_500, 'What does the pricing look like if we add the reporting dashboard?'),
  line(
    5,
    'me',
    36_000,
    'It is included in the Growth plan, so there is no extra pricing for your team.',
  ),
  line(6, 'them', 44_200, 'And SSO? Our IT lead will ask about that first.'),
  line(7, 'me', 51_000, 'SSO ships in July. I can send the security questionnaire today.'),
  line(
    8,
    'them',
    187_000,
    'Perfect. If the timeline holds, we are ready to sign the renewal in September.',
  ),
]

function detailFor(s: SessionSummary): SessionDetail {
  const rich = s.id === 's1'
  return {
    ...s,
    modeName: 'Sales call',
    postCallError:
      s.status === 'failed' ? 'The notes model timed out. Your transcript is safe.' : null,
    actionItems: rich ? ACTIONS : [],
    transcript: rich ? TRANSCRIPT : s.status === 'recovered' ? TRANSCRIPT.slice(0, 3) : [],
    notes: rich
      ? {
          title: s.title,
          summary:
            'Acme reviewed the Q3 roadmap. Their main concern is the analytics milestone, which slipped twice last year; it is now planned for August with a dedicated team. The reporting dashboard is included in the Growth plan, and SSO ships in July. Acme is ready to renew in September if the timeline holds.',
          keyPoints: [
            'Analytics milestone moved to August with a dedicated team',
            'Reporting dashboard is included in the Growth plan at no extra cost',
            'SSO ships in July; their IT lead will review security first',
            'Renewal decision expected in September',
          ],
          decisions: ['Acme will renew in September if the August milestone holds'],
        }
      : null,
    email: rich
      ? {
          subject: 'Q3 roadmap: timeline, SSO and next steps',
          body: 'Hi Dana,\n\nThanks for the time today. As promised, here is a short recap:\n\n- The analytics milestone is now planned for August with a dedicated team.\n- The reporting dashboard is included in your Growth plan.\n- SSO ships in July; I will send the security questionnaire today.\n\nLet me know if anything is missing before your September review.\n\nBest,\nSam',
        }
      : null,
  }
}

const MODES: Mode[] = [
  ['builtin-general', 'General meeting', '💬'],
  ['builtin-sales', 'Sales call', '📈'],
  ['builtin-discovery', 'Client discovery', '🔎'],
  ['builtin-interview', 'Job interview (prep & practice)', '🎯'],
  ['builtin-standup', 'Team standup', '🧩'],
].map(([id, name, icon], i) => ({
  id: id as string,
  name: name as string,
  icon: icon as string,
  instructions: '',
  tone: 'concise',
  autoSuggest: true,
  modelOverrides: {},
  isBuiltin: true,
  sort: i,
}))

const NOTICES: Notice[] = [
  {
    id: 'update-0.2.0',
    kind: 'info',
    title: 'Bluely 0.2.0 is ready to install',
    body: 'Faster answers and a new transcript view. Restart to update.',
    action: { label: 'Restart & update', action: { type: 'installUpdate' } },
    dismissible: true,
  },
]

const STATS: SpeedStats = {
  ttftMs: 412,
  totalMs: 1_930,
  tokensPerSec: 186,
  tokensIn: 3_120,
  tokensOut: 212,
  costUsd: 0.0009,
  provider: 'Google',
  model: 'google/gemini-2.5-flash',
  generationId: 'gen-1',
}

const IDLE: LiveSessionState = {
  status: 'idle',
  sessionId: null,
  startedAt: null,
  modeId: 'builtin-sales',
  audio: { me: { state: 'off', error: null }, them: { state: 'off', error: null } },
  warnings: [],
  autoSuggest: true,
  showConsentReminder: false,
  lastError: null,
}

interface FakeState {
  sessions: SessionSummary[]
  details: Record<string, SessionDetail>
  keyStatus: KeyStatus
  notices: Notice[]
  modes: Mode[]
  live: LiveSessionState
  chatHistory: AiCard[]
  stats: SpeedStats
  askAnswer: string
  chatAnswer: string
  streamDelayMs: number
}

interface Call {
  ch: string
  req: unknown
}

const CHAT_HISTORY: AiCard[] = [
  {
    id: 'chat-old-1',
    scope: 'meeting_chat',
    sessionId: 's1',
    kind: 'meeting_chat',
    label: 'What did they say about SSO?',
    question: 'What did they say about SSO?',
    usedScreen: false,
    tier: 'smart',
    status: 'done',
    text: 'Their IT lead will ask about **SSO first**. You said it ships in **July** and offered to send the security questionnaire today.',
    error: null,
    stats: STATS,
    citations: [],
    // Earlier than any question asked during the run, whatever the time of day.
    createdAt: Date.now() - 2 * 3_600_000,
  },
]

function initialFakeState(): FakeState {
  return {
    sessions: SESSIONS,
    details: Object.fromEntries(SESSIONS.map((s) => [s.id, detailFor(s)])),
    keyStatus: { hasKey: true, masked: 'sk-or-…9f3c', encryptionAvailable: true },
    notices: NOTICES,
    modes: MODES,
    live: IDLE,
    chatHistory: CHAT_HISTORY,
    stats: STATS,
    askAnswer:
      'Pricing came up in **two meetings**:\n\n- **Acme** asked whether the reporting dashboard costs extra. You confirmed it is included in the Growth plan.\n- **Globex** wanted a volume discount above 200 seats; you offered to follow up with a quote by Friday.',
    chatAnswer:
      'They are ready to **renew in September**, as long as the analytics milestone ships in August.',
    streamDelayMs: 45,
  }
}

// ───────────────────────────── fake backend ─────────────────────────────

async function installFakes(app: ElectronApplication, state: FakeState): Promise<void> {
  await app.evaluate(({ ipcMain, BrowserWindow }, init) => {
    type Req = Record<string, unknown>
    const g = globalThis as unknown as {
      __fake: typeof init
      __calls: { ch: string; req: unknown }[]
      __settings: Record<string, unknown> | null
    }
    g.__fake = init
    g.__calls = []
    const send = (event: string, payload: unknown) => {
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send(event, payload)
    }
    // Main's real NoticeCenter still pushes 'app:notices' when, e.g., startup model validation
    // or an update check finishes, which depends on network timing. Keep the fake notices
    // authoritative so such a late push cannot swap them out in the middle of a test.
    for (const w of BrowserWindow.getAllWindows()) {
      const wc = w.webContents
      const realSend = wc.send.bind(wc)
      wc.send = (channel: string, ...args: unknown[]) =>
        channel === 'app:notices' ? realSend(channel, g.__fake.notices) : realSend(channel, ...args)
    }
    const replace = (ch: string, fn: (req: Req) => unknown) => {
      ipcMain.removeHandler(ch)
      ipcMain.handle(ch, async (_e, raw: unknown) => {
        const req = (raw ?? {}) as Req
        g.__calls.push({ ch, req })
        try {
          return { ok: true, data: await fn(req) }
        } catch (err) {
          return { ok: false, error: { code: 'fake_error', message: String(err) } }
        }
      })
    }
    const stream = (card: Record<string, unknown>, answer: string) => {
      const id = card['id'] as string
      setTimeout(() => {
        send('ai:card', card)
        const words = answer.split(/(?<= )/)
        words.forEach((w, i) => {
          setTimeout(() => send('ai:delta', { id, delta: w }), (i + 1) * g.__fake.streamDelayMs)
        })
        setTimeout(
          () => send('ai:done', { id, text: answer, stats: g.__fake.stats }),
          (words.length + 2) * g.__fake.streamDelayMs,
        )
      }, 30)
    }
    let seq = 0

    replace('key:getStatus', () => g.__fake.keyStatus)
    replace('key:test', () => ({
      ok: true,
      label: 'bluely',
      limit: null,
      usage: 1.2,
      remaining: null,
      isFreeTier: false,
      latencyMs: 210,
      error: null,
    }))
    replace('modes:list', () => g.__fake.modes)
    replace('modes:setActive', (req) => {
      if (g.__settings) {
        g.__settings = { ...g.__settings, activeModeId: req['id'] }
        send('settings:changed', g.__settings)
      }
    })
    replace('session:getState', () => g.__fake.live)
    replace('session:start', () => {
      g.__fake.live = {
        ...g.__fake.live,
        status: 'live',
        sessionId: 'live-1',
        startedAt: Date.now() - 754_000,
      }
      send('session:state', g.__fake.live)
      return { sessionId: 'live-1' }
    })
    replace('session:stop', () => {
      g.__fake.live = { ...g.__fake.live, status: 'processing' }
      send('session:state', g.__fake.live)
    })
    replace('app:getNotices', () => g.__fake.notices)
    replace('app:dismissNotice', (req) => {
      // A test can make main publish right before it handles the dismissal (see the notice
      // dismiss test). Unlike main, the fake does not publish the new list afterwards: the
      // window must not rely on that to drop a notice it was told to dismiss.
      ;(globalThis as unknown as { __beforeDismiss?: () => void }).__beforeDismiss?.()
      g.__fake.notices = g.__fake.notices.filter((n) => n.id !== req['id'])
    })
    replace('updater:install', () => {
      // When it was asked to install: main refuses while a call runs or its notes are written.
      g.__calls.push({ ch: 'updater:install:status', req: g.__fake.live.status })
    })
    replace('sessions:list', (req) => {
      const before = typeof req['before'] === 'number' ? req['before'] : Infinity
      const limit = typeof req['limit'] === 'number' ? req['limit'] : 50
      return g.__fake.sessions.filter((s) => s.startedAt < before).slice(0, limit)
    })
    replace('sessions:get', (req) => g.__fake.details[req['id'] as string] ?? null)
    replace('sessions:rename', (req) => {
      const d = g.__fake.details[req['id'] as string]
      if (d) d.title = req['title'] as string
      g.__fake.sessions = g.__fake.sessions.map((s) =>
        s.id === req['id'] ? { ...s, title: req['title'] as string } : s,
      )
      send('sessions:changed', { id: req['id'] })
    })
    replace('sessions:delete', (req) => {
      g.__fake.sessions = g.__fake.sessions.filter((s) => s.id !== req['id'])
    })
    replace('sessions:regenerate', () => undefined)
    replace('sessions:updateEmail', (req) => {
      const d = g.__fake.details[req['id'] as string]
      if (d) d.email = { subject: req['subject'] as string, body: req['body'] as string }
    })
    replace('sessions:openMailDraft', () => undefined)
    replace('sessions:exportMarkdown', (req) => ({
      path:
        req['target'] === 'file'
          ? 'C:\\Users\\sam\\Documents\\Q3 roadmap review with Acme.md'
          : null,
    }))
    replace('actionItems:setDone', (req) => {
      for (const d of Object.values(g.__fake.details)) {
        const item = d.actionItems.find((a) => a.id === req['id'])
        if (item) {
          item.done = req['done'] as boolean
          return item
        }
      }
      throw new Error('no such item')
    })
    replace('search:query', (req) => {
      const query = String(req['query'] ?? '')
      const q = query.toLowerCase()
      const looksLikeQuestion = /\?$/.test(query) || /^(what|how|who|when|why)\b/i.test(query)
      const groups = []
      const mark = (text: string, word: string) =>
        text.replace(new RegExp(`(${word})`, 'ig'), '\u0002$1\u0003')
      const word = q.includes('pric') ? 'pricing' : q.includes('prc') ? 'pricing' : q
      if (word === 'pricing') {
        const s1 = g.__fake.sessions.find((s) => s.id === 's1')
        const s4 = g.__fake.sessions.find((s) => s.id === 's4')
        if (s4)
          groups.push({
            session: s4,
            hits: [
              {
                sessionId: 's4',
                kind: 'title',
                refId: null,
                snippet: mark(s4.title, word),
                score: 9,
              },
              {
                sessionId: 's4',
                kind: 'transcript',
                refId: 'x1',
                snippet: mark('…they wanted volume pricing above 200 seats and a…', word),
                score: 7,
              },
              {
                sessionId: 's4',
                kind: 'action_item',
                refId: 'x2',
                snippet: mark('Send Globex a pricing quote for 250 seats by Friday', word),
                score: 6,
              },
            ],
          })
        if (s1)
          groups.push({
            session: s1,
            hits: [
              {
                sessionId: 's1',
                kind: 'transcript',
                refId: 'l4',
                snippet: mark(
                  'What does the pricing look like if we add the reporting dashboard?',
                  word,
                ),
                score: 5,
              },
              {
                sessionId: 's1',
                kind: 'notes',
                refId: null,
                snippet: mark(
                  '…dashboard is included in the Growth plan, so no extra pricing…',
                  word,
                ),
                score: 4,
              },
            ],
          })
      }
      return { query, looksLikeQuestion, fuzzy: q.includes('prc'), groups }
    })
    replace('search:ask', (req) => {
      const id = `ask-${++seq}`
      const s1 = g.__fake.sessions.find((s) => s.id === 's1')
      const s4 = g.__fake.sessions.find((s) => s.id === 's4')
      stream(
        {
          id,
          scope: 'search',
          sessionId: null,
          kind: 'search_ask',
          label: req['question'],
          question: req['question'],
          usedScreen: false,
          tier: 'smart',
          status: 'streaming',
          text: '',
          error: null,
          stats: null,
          citations: [s1, s4]
            .filter((s) => !!s)
            .map((s) => ({ sessionId: s.id, title: s.title, startedAt: s.startedAt })),
          createdAt: Date.now(),
        },
        g.__fake.askAnswer,
      )
      return { id }
    })
    replace('ai:getCards', (req) =>
      g.__fake.chatHistory.filter((c) => c.sessionId === req['sessionId']),
    )
    replace('sessions:chat', (req) => {
      const id = `chat-${++seq}`
      stream(
        {
          id,
          scope: 'meeting_chat',
          sessionId: req['id'],
          kind: 'meeting_chat',
          label: req['question'],
          question: req['question'],
          usedScreen: false,
          tier: 'smart',
          status: 'streaming',
          text: '',
          error: null,
          stats: null,
          citations: [],
          createdAt: Date.now(),
        },
        g.__fake.chatAnswer,
      )
      return { id }
    })
  }, state)
}

async function patchFake(app: ElectronApplication, patch: Partial<FakeState>): Promise<void> {
  await app.evaluate((_e, p) => {
    const g = globalThis as unknown as { __fake: Record<string, unknown> }
    Object.assign(g.__fake, p)
  }, patch)
}

async function calls(app: ElectronApplication, ch: string): Promise<Call[]> {
  return app.evaluate((_e, name) => {
    const g = globalThis as unknown as { __calls: { ch: string; req: unknown }[] }
    return g.__calls.filter((c) => c.ch === name)
  }, ch)
}

async function push(app: ElectronApplication, event: string, payload: unknown): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, [e, p]) => {
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send(e as string, p)
    },
    [event, payload] as const,
  )
}

/** Changes a meeting in the fake backend and broadcasts sessions:changed, as main does. */
async function changeDetail(
  app: ElectronApplication,
  id: string,
  patch: Partial<SessionDetail>,
): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, [sid, p]) => {
      const g = globalThis as unknown as {
        __fake: { details: Record<string, Record<string, unknown>> }
      }
      Object.assign(g.__fake.details[sid as string]!, p)
      for (const w of BrowserWindow.getAllWindows())
        w.webContents.send('sessions:changed', { id: sid })
    },
    [id, patch] as const,
  )
}

/** changeDetail, then waits until the open meeting page has reloaded the changed detail. */
async function changeDetailAndReload(
  app: ElectronApplication,
  page: Page,
  id: string,
  patch: Partial<SessionDetail>,
): Promise<void> {
  const loads = (await calls(app, 'sessions:get')).length
  await changeDetail(app, id, patch)
  await expect.poll(async () => (await calls(app, 'sessions:get')).length).toBeGreaterThan(loads)
  await page.waitForTimeout(150)
}

/** Broadcasts settings:changed with the fake settings' activeTier changed (overlay chip). */
async function setFakeTier(app: ElectronApplication, tier: 'fast' | 'smart'): Promise<void> {
  await app.evaluate(({ BrowserWindow }, activeTier) => {
    const g = globalThis as unknown as { __settings: Record<string, Record<string, unknown>> }
    g.__settings = { ...g.__settings, models: { ...g.__settings['models'], activeTier } }
    for (const w of BrowserWindow.getAllWindows())
      w.webContents.send('settings:changed', g.__settings)
  }, tier)
}

async function setSettings(page: Page, patch: Record<string, unknown>): Promise<void> {
  await page.evaluate((p) => window.bluely.invoke('settings:update', { patch: p }), patch)
}

/** Lets the fake modes:setActive broadcast realistic settings:changed payloads. */
async function syncSettingsToFake(app: ElectronApplication, page: Page): Promise<void> {
  const env = await page.evaluate(() => window.bluely.invoke('settings:get', undefined))
  const settings = env.ok ? env.data : null
  await app.evaluate((_e, s) => {
    const g = globalThis as unknown as { __settings: unknown }
    g.__settings = s
  }, settings)
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return
  mkdirSync(SHOTS, { recursive: true })
  await page.waitForTimeout(250)
  await page.screenshot({ path: join(SHOTS, `${name}.png`) })
}

async function bothThemes(page: Page, name: string): Promise<void> {
  if (!SHOTS) return
  await shot(page, `${name}-dark`)
  await setSettings(page, { general: { theme: 'light' } })
  await shot(page, `${name}-light`)
  await setSettings(page, { general: { theme: 'dark' } })
}

// ───────────────────────────── tests ─────────────────────────────

let ctx: LaunchedApp
let page: Page

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  ctx = await launchApp()
  page = ctx.main
  await ctx.app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'Bluely')
    win?.setSize(1120, 760)
    win?.center()
  })
  await installFakes(ctx.app, initialFakeState())
})

test.afterAll(async () => {
  await ctx?.app.close()
})

test('first run shows onboarding from the slot, then the home page', async () => {
  await expect(page.getByTestId('onboarding')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Close' }).first()).toBeVisible()
  // The real onboarding is covered by settingsui.spec.ts; finish it directly here.
  await page.evaluate(() =>
    window.bluely.invoke('settings:update', { patch: { general: { onboardingComplete: true } } }),
  )
  await expect(page.getByTestId('home-page')).toBeVisible()
  const env = await page.evaluate(() => window.bluely.invoke('settings:get', undefined))
  expect(env.ok && env.data.general.onboardingComplete).toBe(true)
  await syncSettingsToFake(ctx.app, page)
})

test('home: header, key status, notices and day-grouped history', async () => {
  await page.reload()
  await expect(page.getByText('Bluely', { exact: true }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start Bluely' }).first()).toBeVisible()
  await expect(page.getByText('gemini-2.5-flash')).toBeVisible()
  await expect(page.getByText('OpenRouter connected')).toBeVisible()
  await expect(page.getByRole('button', { name: /Mode: General meeting/ })).toBeVisible()

  // Notices.
  await expect(page.getByText('Bluely 0.2.0 is ready to install')).toBeVisible()

  // History grouped by day with duration badges and times.
  const rows = page.getByTestId('session-row')
  await expect(rows).toHaveCount(SESSIONS.length)
  await expect(rows.first()).toContainText('Q3 roadmap review with Acme')
  await expect(rows.first()).toContainText('1:27:35')
  await expect(rows.first()).toContainText('10:04am')
  await expect(page.getByText('Untitled meeting')).toBeVisible()
  await expect(page.getByText('Generating notes', { exact: true })).toBeVisible()
  await expect(page.getByText('Recovered', { exact: true })).toBeVisible()
  await expect(page.getByText('Notes failed', { exact: true })).toBeVisible()
  const headers = page.locator('[data-testid="home-page"] h3')
  await expect(headers).toHaveCount(4)
  await expect(page.getByRole('button', { name: 'Back' })).toBeDisabled()
  await bothThemes(page, 'home')
})

test('mode pill lists modes and switches the active one', async () => {
  await page.getByRole('button', { name: /Mode: General meeting/ }).click()
  await expect(page.getByRole('menuitemradio', { name: /Sales call/ })).toBeVisible()
  await shot(page, 'mode-menu-dark')
  await page.getByRole('menuitemradio', { name: /Sales call/ }).click()
  await expect(page.getByRole('button', { name: /Mode: Sales call/ })).toBeVisible()
  const sent = await calls(ctx.app, 'modes:setActive')
  expect(sent.at(-1)?.req).toEqual({ id: 'builtin-sales' })
})

test('header subtitle names the model that answers (Mode override, Fast/Smart tier)', async () => {
  // Sales call is active now; give it a Smart override the way the Modes editor would.
  const withOverride = MODES.map((m) =>
    m.id === 'builtin-sales'
      ? { ...m, modelOverrides: { smart: 'anthropic/claude-sonnet-4.5' } }
      : m,
  )
  await push(ctx.app, 'modes:changed', withOverride)
  await expect(page.getByText('claude-sonnet-4.5', { exact: true })).toBeVisible()
  // The overlay chip switches answers to the Fast tier (no override for it). Broadcast it from
  // the fake settings, like modes:setActive does, so the real store keeps its state.
  await setFakeTier(ctx.app, 'fast')
  await expect(page.getByText('llama-3.3-70b-instruct', { exact: true })).toBeVisible()
  await setFakeTier(ctx.app, 'smart')
  await push(ctx.app, 'modes:changed', MODES)
  await expect(page.getByText('gemini-2.5-flash', { exact: true })).toBeVisible()
})

test('notice dismiss calls app:dismissNotice', async () => {
  // Main publishes its notice list whenever something changes, e.g. when the startup model
  // validation finishes. Make that happen right as the user dismisses the update notice: the
  // list main computed just before it handled the dismissal still has that notice (and adds a
  // model notice). It reaches the window after the click; the dismissed notice must stay gone.
  await ctx.app.evaluate(({ BrowserWindow }) => {
    const g = globalThis as unknown as {
      __fake: { notices: Notice[] }
      __beforeDismiss?: () => void
    }
    g.__beforeDismiss = () => {
      g.__beforeDismiss = undefined
      g.__fake.notices = [
        ...g.__fake.notices,
        {
          id: 'model-fast-x',
          kind: 'info',
          title: 'Fast model replaced',
          body: 'The default Fast model is not available any more.',
          action: null,
          dismissible: true,
        },
      ]
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send('app:notices', [])
    }
  })
  // Records whether the notice comes back at any moment after the click took it away (a later
  // publish from main would hide it again, so checking only the end state could miss it).
  await page.evaluate(() => {
    const w = window as unknown as { __noticeCameBack?: boolean }
    const shown = () => !!document.body.textContent?.includes('Bluely 0.2.0 is ready to install')
    let gone = false
    w.__noticeCameBack = false
    new MutationObserver(() => {
      if (!shown()) gone = true
      else if (gone) w.__noticeCameBack = true
    }).observe(document.body, { childList: true, subtree: true, characterData: true })
  })
  await page.getByRole('button', { name: 'Dismiss' }).click()
  // The racing list has been shown (the model notice arrived with it)…
  await expect(page.getByText('Fast model replaced')).toBeVisible()
  // …without bringing back the notice that was dismissed, not even for a moment.
  await expect(page.getByText('Bluely 0.2.0 is ready to install')).toHaveCount(0)
  expect(
    await page.evaluate(
      () => (window as unknown as { __noticeCameBack?: boolean }).__noticeCameBack,
    ),
  ).toBe(false)
  expect((await calls(ctx.app, 'app:dismissNotice')).at(-1)?.req).toEqual({ id: 'update-0.2.0' })
  // Dismiss the model notice too, so the pages below look as before.
  await page.getByRole('button', { name: 'Dismiss' }).click()
  await expect(page.getByText('Fast model replaced')).toHaveCount(0)
  expect((await calls(ctx.app, 'app:dismissNotice')).at(-1)?.req).toEqual({ id: 'model-fast-x' })
})

test('search shows grouped, highlighted hits and opens the right tab', async () => {
  const search = page.getByRole('searchbox', { name: /Search or ask/ })
  await page.keyboard.press('Control+k')
  await expect(search).toBeFocused()
  await search.fill('pricing')
  const results = page.getByTestId('search-results')
  await expect(results.getByTestId('search-group')).toHaveCount(2)
  await expect(results.locator('mark').first()).toHaveText(/pricing/i)
  await expect(results.getByText('Action item')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Back' })).toBeEnabled()
  await bothThemes(page, 'search')

  // Typo tolerance note.
  await search.fill('prcing')
  await expect(page.getByTestId('fuzzy-note')).toBeVisible()

  // ↓ moves into results; Enter on a transcript hit opens the Transcript tab.
  await search.fill('pricing')
  await expect(results.getByTestId('search-group')).toHaveCount(2)
  await search.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await expect(page.locator(':focus')).toContainText('Transcript')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('session-page')).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Transcript' })).toHaveAttribute(
    'data-state',
    'active',
  )
  await expect(search).toHaveValue('')
  await page.getByRole('button', { name: 'Back' }).click()
  await expect(page.getByTestId('home-page')).toBeVisible()
})

test('search: Esc clears, empty results state', async () => {
  const search = page.getByRole('searchbox', { name: /Search or ask/ })
  await search.fill('kangaroo')
  await expect(page.getByTestId('search-empty')).toBeVisible()
  await shot(page, 'search-empty-dark')
  await search.press('Escape')
  await expect(search).toHaveValue('')
  await expect(page.getByTestId('home-page')).toBeVisible()
})

test('question-like search offers "Ask Bluely" and streams a cited answer', async () => {
  const search = page.getByRole('searchbox', { name: /Search or ask/ })
  await search.fill('What did customers say about pricing?')
  const ask = page.getByTestId('ask-across')
  await expect(ask).toBeVisible()
  await shot(page, 'ask-prompt-dark')
  await patchFake(ctx.app, { streamDelayMs: 120 })
  await search.press('Enter')
  const card = page.getByTestId('answer-card')
  await expect(card).toBeVisible()
  await expect(card).toContainText('Pricing came up', { timeout: 5000 })
  await shot(page, 'ask-streaming-dark')
  await expect(card).toContainText('⚡', { timeout: 15000 })
  await expect(card).toContainText('gemini-2.5-flash')
  await expect(card.getByRole('button', { name: /Q3 roadmap review with Acme ·/ })).toBeVisible()
  await bothThemes(page, 'ask-answer')
  await patchFake(ctx.app, { streamDelayMs: 25 })
  const asked = await calls(ctx.app, 'search:ask')
  expect(asked.at(-1)?.req).toEqual({ question: 'What did customers say about pricing?' })

  // Citation chips open the cited meeting.
  await card.getByRole('button', { name: /Pricing call with Globex ·/ }).click()
  await expect(page.getByTestId('session-page')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Pricing call with Globex' })).toBeVisible()
  await page.getByRole('button', { name: 'Back' }).click()
})

test('session page: notes, rename, export and copy', async () => {
  await page.getByTestId('session-row').first().click()
  const sessionPage = page.getByTestId('session-page')
  await expect(sessionPage).toBeVisible()
  await expect(page.getByTestId('notes-tab')).toContainText('Acme reviewed the Q3 roadmap')
  await expect(page.getByTestId('notes-tab')).toContainText('Key points')
  await expect(sessionPage).toContainText('Sales call')
  await expect(sessionPage).toContainText('1:27:35')
  await bothThemes(page, 'session-notes')

  // Inline rename: Esc cancels, Enter saves.
  await page.getByRole('button', { name: 'Q3 roadmap review with Acme' }).click()
  const input = page.getByTestId('title-input')
  await input.fill('Nope')
  await input.press('Escape')
  await expect(page.getByRole('heading', { name: 'Q3 roadmap review with Acme' })).toBeVisible()
  await page.getByRole('button', { name: 'Q3 roadmap review with Acme' }).click()
  await page.getByTestId('title-input').fill('Q3 roadmap review: Acme')
  await page.getByTestId('title-input').press('Enter')
  await expect(page.getByRole('heading', { name: 'Q3 roadmap review: Acme' })).toBeVisible()
  expect((await calls(ctx.app, 'sessions:rename')).at(-1)?.req).toEqual({
    id: 's1',
    title: 'Q3 roadmap review: Acme',
  })

  await page.getByRole('button', { name: 'Export' }).click()
  await expect(page.getByTestId('toast').filter({ hasText: 'Saved to' })).toBeVisible()
  await shot(page, 'session-export-toast-dark')
  await page.getByRole('button', { name: 'Copy as Markdown' }).click()
  await expect(page.getByTestId('toast').filter({ hasText: 'Copied as Markdown' })).toBeVisible()
  expect((await calls(ctx.app, 'sessions:exportMarkdown')).map((c) => c.req)).toEqual([
    { id: 's1', target: 'file' },
    { id: 's1', target: 'clipboard' },
  ])
})

test('session page: a background title change does not discard the title being typed', async () => {
  await page.getByRole('button', { name: 'Q3 roadmap review: Acme' }).click()
  const input = page.getByTestId('title-input')
  await input.fill('Acme pricing kickoff')
  // Notes finish meanwhile and main stores its own title.
  const loads = (await calls(ctx.app, 'sessions:get')).length
  await changeDetail(ctx.app, 's1', { title: 'Pricing discussion with Acme' })
  await expect
    .poll(async () => (await calls(ctx.app, 'sessions:get')).length)
    .toBeGreaterThan(loads)
  await page.waitForTimeout(150)
  await expect(input).toBeVisible()
  await expect(input).toHaveValue('Acme pricing kickoff')
  await input.press('Enter')
  await expect(page.getByRole('heading', { name: 'Acme pricing kickoff' })).toBeVisible()
  expect((await calls(ctx.app, 'sessions:rename')).at(-1)?.req).toEqual({
    id: 's1',
    title: 'Acme pricing kickoff',
  })
  // Not editing: a background change shows up.
  await changeDetail(ctx.app, 's1', { title: 'Q3 roadmap review: Acme' })
  await expect(page.getByRole('heading', { name: 'Q3 roadmap review: Acme' })).toBeVisible()
})

test('session page: an untouched title edit never writes over a title changed in the background', async () => {
  const renames = (await calls(ctx.app, 'sessions:rename')).length

  // Renamed elsewhere (another window) while this editor is open; clicking away keeps it.
  await page.getByRole('button', { name: 'Q3 roadmap review: Acme' }).click()
  const input = page.getByTestId('title-input')
  await expect(input).toHaveValue('Q3 roadmap review: Acme')
  await changeDetailAndReload(ctx.app, page, 's1', { title: 'Acme: Q3 roadmap' })
  await input.blur()
  await expect(page.getByRole('heading', { name: 'Acme: Q3 roadmap' })).toBeVisible()

  // Untitled meeting: the edit starts empty (the placeholder is not a value), notes then name
  // the meeting, and Enter without typing keeps the generated title.
  await push(ctx.app, 'navigate', { name: 'session', sessionId: 's7', tab: 'notes' })
  await page.getByRole('button', { name: 'Untitled meeting', exact: true }).click()
  await expect(input).toHaveValue('')
  await expect(input).toHaveAttribute('placeholder', 'Untitled meeting')
  await changeDetailAndReload(ctx.app, page, 's7', { title: 'Pricing discussion with Acme' })
  await input.press('Enter')
  await expect(page.getByRole('heading', { name: 'Pricing discussion with Acme' })).toBeVisible()
  expect(await calls(ctx.app, 'sessions:rename')).toHaveLength(renames)

  // Restore the fixtures later tests rely on.
  await changeDetail(ctx.app, 's7', { title: '' })
  await expect(page.getByRole('heading', { name: 'Untitled meeting' })).toBeVisible()
  await page.getByRole('button', { name: 'Back' }).click()
  await changeDetail(ctx.app, 's1', { title: 'Q3 roadmap review: Acme' })
  await expect(page.getByRole('heading', { name: 'Q3 roadmap review: Acme' })).toBeVisible()
})

test('session page: a typed title edit saves what the input shows, even its start value', async () => {
  // Opened on the stored title, the user types; another window renames the meeting meanwhile;
  // the user then types back to exactly the start value and presses Enter.
  await page.getByRole('button', { name: 'Q3 roadmap review: Acme' }).click()
  const input = page.getByTestId('title-input')
  await input.fill('Acme kickoff')
  await changeDetailAndReload(ctx.app, page, 's1', { title: 'Acme: Q3 roadmap' })
  await input.fill('Q3 roadmap review: Acme')
  await input.press('Enter')
  await expect(page.getByRole('heading', { name: 'Q3 roadmap review: Acme' })).toBeVisible()
  expect((await calls(ctx.app, 'sessions:rename')).at(-1)?.req).toEqual({
    id: 's1',
    title: 'Q3 roadmap review: Acme',
  })
})

test('session page: action items toggle optimistically and persist', async () => {
  await page.getByRole('tab', { name: /Action items/ }).click()
  const tab = page.getByTestId('actions-tab')
  await expect(tab).toContainText('2 open · 1 done')
  await expect(tab).toContainText('Priya')
  await expect(tab).toContainText('Friday')
  await bothThemes(page, 'session-actions')
  await tab.getByRole('checkbox').first().click()
  await expect(tab).toContainText('1 open · 2 done')
  expect((await calls(ctx.app, 'actionItems:setDone')).at(-1)?.req).toEqual({
    id: 'a1',
    done: true,
  })
})

test('session page: transcript with Me/Them labels and a filter', async () => {
  await page.getByRole('tab', { name: 'Transcript' }).click()
  const tab = page.getByTestId('transcript-tab')
  await expect(tab.locator('li')).toHaveCount(TRANSCRIPT.length)
  await expect(tab).toContainText('[00:04]')
  await expect(tab).toContainText('[03:07]')
  await bothThemes(page, 'session-transcript')
  await tab.getByRole('textbox', { name: 'Filter transcript' }).fill('sso')
  await expect(tab.locator('li')).toHaveCount(2)
  await expect(tab.locator('mark').first()).toHaveText(/sso/i)
  await shot(page, 'session-transcript-filter-dark')
})

test('session page: follow-up email autosaves and opens a mail draft', async () => {
  await page.getByRole('tab', { name: 'Follow-up email' }).click()
  const tab = page.getByTestId('email-tab')
  const subject = tab.getByRole('textbox', { name: 'Subject' })
  await expect(subject).toHaveValue('Q3 roadmap: timeline, SSO and next steps')
  await bothThemes(page, 'session-email')
  await subject.fill('Q3 roadmap: next steps')
  await expect(tab.getByText('Saved')).toBeVisible()
  const saved = await calls(ctx.app, 'sessions:updateEmail')
  expect(saved).toHaveLength(1)
  expect(saved[0]?.req).toMatchObject({ id: 's1', subject: 'Q3 roadmap: next steps' })
  await tab.getByRole('button', { name: 'Open in mail app' }).click()
  await expect.poll(async () => (await calls(ctx.app, 'sessions:openMailDraft')).length).toBe(1)
})

test('session page: the email tab shows what is stored, and stores what it shows', async () => {
  const tab = page.getByTestId('email-tab')
  const subject = tab.getByRole('textbox', { name: 'Subject' })
  // Main writes a newer email after the user's edit was saved (e.g. generation finished):
  // the tab must show it, since "Open in mail app" sends the stored one.
  await changeDetail(ctx.app, 's1', {
    email: { subject: 'Generated: Q3 next steps', body: 'Hi Dana, here is the recap.' },
  })
  await expect(subject).toHaveValue('Generated: Q3 next steps')
  await expect(tab.getByRole('textbox', { name: 'Message' })).toHaveValue(
    'Hi Dana, here is the recap.',
  )

  // Typing and opening the mail app right away stores the typed text first.
  const before = (await calls(ctx.app, 'sessions:updateEmail')).length
  await subject.fill('Typed right before opening')
  await tab.getByRole('button', { name: 'Open in mail app' }).click()
  await expect.poll(async () => (await calls(ctx.app, 'sessions:openMailDraft')).length).toBe(2)
  const order = await ctx.app.evaluate(() => {
    const g = globalThis as unknown as { __calls: { ch: string; req: unknown }[] }
    return g.__calls
      .filter((c) => c.ch === 'sessions:updateEmail' || c.ch === 'sessions:openMailDraft')
      .map((c) => c.ch)
  })
  expect(order.slice(before + 1)).toEqual(['sessions:updateEmail', 'sessions:openMailDraft'])
  expect((await calls(ctx.app, 'sessions:updateEmail')).at(-1)?.req).toMatchObject({
    id: 's1',
    subject: 'Typed right before opening',
  })
})

test('session page: AI chat shows history and streams new answers', async () => {
  await page.getByRole('tab', { name: 'AI chat' }).click()
  const tab = page.getByTestId('chat-tab')
  await expect(tab).toContainText('What did they say about SSO?')
  const box = tab.getByRole('textbox', { name: 'Ask about this meeting…' })
  await box.fill('Are they ready to renew?')
  await box.press('Enter')
  await expect(tab.getByTestId('answer-card')).toHaveCount(2)
  await expect(tab.getByTestId('answer-card').last()).toContainText('renew in September', {
    timeout: 10000,
  })
  await expect(tab.getByTestId('answer-card').last()).toContainText('⚡')
  expect((await calls(ctx.app, 'sessions:chat')).at(-1)?.req).toEqual({
    id: 's1',
    question: 'Are they ready to renew?',
  })
  await bothThemes(page, 'session-chat')
})

test('session page: switching tabs keeps the unsent question and the transcript filter', async () => {
  const box = page.getByRole('textbox', { name: 'Ask about this meeting…' })
  await box.fill('What did they say about the September')
  await page.getByRole('tab', { name: 'Transcript' }).click()
  const filter = page.getByRole('textbox', { name: 'Filter transcript' })
  await expect(filter).toHaveValue('sso')
  await expect(page.getByTestId('transcript-tab').locator('li')).toHaveCount(2)
  await page.getByRole('tab', { name: 'Notes' }).click()
  await page.getByRole('tab', { name: 'AI chat' }).click()
  await expect(box).toHaveValue('What did they say about the September')
  await page.getByRole('tab', { name: 'Transcript' }).click()
  await expect(filter).toHaveValue('sso')
  await filter.fill('')
  await page.getByRole('tab', { name: 'AI chat' }).click()
  await box.fill('')
})

test('session status banners: recovered, failed and processing', async () => {
  await page.getByRole('button', { name: 'Back' }).click()
  await page.getByRole('button', { name: /^Open Interview practice: system design/ }).click()
  await expect(page.getByText('This session ended unexpectedly. Generate notes?')).toBeVisible()
  await shot(page, 'session-recovered-dark')
  await page.getByRole('button', { name: 'Generate notes' }).first().click()
  expect((await calls(ctx.app, 'sessions:regenerate')).at(-1)?.req).toEqual({ id: 's5' })
  await expect(
    page.getByRole('status').filter({ hasText: 'Generating notes…' }).first(),
  ).toBeVisible()

  await page.getByRole('button', { name: 'Back' }).click()
  await page.getByRole('button', { name: /^Open Investor update with Lakeside Ventures/ }).click()
  await expect(page.getByText('Notes couldn’t be generated')).toBeVisible()
  await expect(page.getByText('The notes model timed out.')).toBeVisible()
  await bothThemes(page, 'session-failed')
  await page.getByRole('button', { name: 'Back' }).click()
})

test('partial post-call failure: per-part messages and Retry regenerates only those parts', async () => {
  await page.getByRole('button', { name: /^Open Investor update with Lakeside Ventures/ }).click()
  await changeDetail(ctx.app, 's6', {
    status: 'done',
    postCallError: 'notes: The model timed out. · email: Rate limited by the provider.',
  })
  const list = page.getByTestId('post-call-errors')
  await expect(list.locator('li')).toHaveText([
    'Notes: The model timed out.',
    'Follow-up email: Rate limited by the provider.',
  ])
  await page.getByRole('button', { name: 'Retry' }).click()
  await expect
    .poll(async () => (await calls(ctx.app, 'sessions:regenerate')).at(-1)?.req)
    .toEqual({ id: 's6', parts: ['notes', 'email'] })
  await page.getByRole('button', { name: 'Back' }).click()
})

test('email tab is read-only while the email is still being generated', async () => {
  await page.getByRole('button', { name: /^Open Customer discovery: Northwind Traders/ }).click()
  await page.getByRole('tab', { name: 'Follow-up email' }).click()
  const tab = page.getByTestId('email-tab')
  const subject = tab.getByRole('textbox', { name: 'Subject' })
  await expect(tab.getByText('Drafting a follow-up email…')).toBeVisible()
  await expect(subject).toBeDisabled()
  await expect(tab.getByRole('textbox', { name: 'Message' })).toBeDisabled()
  await expect(tab.getByRole('button', { name: 'Open in mail app' })).toBeDisabled()
  await changeDetail(ctx.app, 's2', {
    status: 'done',
    email: { subject: 'Northwind: next steps', body: 'Hi Lee,\n\nThanks for the call.' },
  })
  await expect(subject).toBeEnabled()
  await expect(subject).toHaveValue('Northwind: next steps')
  await page.getByRole('button', { name: 'Back' }).click()
})

test('navigate event opens a session (after a call ends)', async () => {
  await push(ctx.app, 'navigate', { name: 'session', sessionId: 's3', tab: 'notes' })
  await expect(page.getByRole('heading', { name: 'Weekly design sync' })).toBeVisible()
  await page.getByRole('button', { name: 'Back' }).click()
  await expect(page.getByTestId('home-page')).toBeVisible()
})

test('delete from the row menu asks for confirmation', async () => {
  const row = page.getByTestId('session-row').filter({ hasText: 'Onboarding call with Initech' })
  await row.hover()
  await row.getByRole('button', { name: /More actions for/ }).click()
  await page.getByRole('menuitem', { name: 'Delete…' }).click()
  await expect(page.getByRole('dialog', { name: 'Delete this meeting?' })).toBeVisible()
  await shot(page, 'delete-confirm-dark')
  await page.getByRole('button', { name: 'Delete meeting' }).click()
  await expect(row).toHaveCount(0)
  expect((await calls(ctx.app, 'sessions:delete')).at(-1)?.req).toEqual({ id: 's8' })
})

test('keyboard focus follows navigation: into a meeting, back to its row, after delete', async () => {
  const rowButton = page.getByRole('button', { name: /^Open Weekly design sync/ })
  await rowButton.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: 'Weekly design sync' })).toBeFocused()
  // The next Tab continues inside the meeting page, not at the top of the window.
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: 'Weekly design sync' })).toBeFocused()
  await page.keyboard.press('Alt+ArrowLeft')
  await expect(page.getByTestId('home-page')).toBeVisible()
  await expect(rowButton).toBeFocused()

  // Delete from the meeting page: its row is gone, so the home page takes focus.
  await page.getByRole('button', { name: /^Open Untitled meeting/ }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('session-page')).toBeVisible()
  await page.getByRole('button', { name: 'Delete meeting' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete meeting' }).click()
  await expect(page.getByTestId('home-page')).toBeVisible()
  await expect(page.getByTestId('home-page')).toBeFocused()
  expect((await calls(ctx.app, 'sessions:delete')).at(-1)?.req).toEqual({ id: 's7' })
})

test('layout holds at the minimum window size', async () => {
  const resize = (w: number, h: number) =>
    ctx.app.evaluate(
      ({ BrowserWindow }, [width, height]) => {
        const win = BrowserWindow.getAllWindows().find((x) => x.getTitle() === 'Bluely')
        win?.setSize(width as number, height as number)
      },
      [w, h] as const,
    )
  await resize(780, 540)
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(780)
  const overflow = () =>
    page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(await overflow()).toBeLessThanOrEqual(0)
  const search = await page.getByRole('searchbox', { name: /Search or ask/ }).boundingBox()
  const avatar = await page.getByRole('button', { name: /^Settings/ }).boundingBox()
  const backBtn = await page.getByRole('button', { name: 'Back' }).boundingBox()
  expect(search && avatar && search.x + search.width < avatar.x).toBe(true)
  expect(search && backBtn && backBtn.x + backBtn.width < search.x).toBe(true)
  await shot(page, 'narrow-home-dark')
  await page.getByTestId('session-row').first().click()
  await expect(page.getByTestId('session-page')).toBeVisible()
  expect(await overflow()).toBeLessThanOrEqual(0)
  await shot(page, 'narrow-session-dark')
  await page.getByRole('button', { name: 'Back' }).click()
  await resize(1120, 760)
})

test('live session: Start → Stop with timer → Generating notes', async () => {
  await page.getByRole('button', { name: 'Start Bluely' }).first().click()
  const stop = page.getByRole('button', { name: /Stop session/ }).first()
  await expect(stop).toBeVisible()
  await expect(stop).toContainText(/12:3\d/)
  await bothThemes(page, 'home-live')
  await stop.click()
  // While notes are generated the next call can already start.
  await expect(page.getByTestId('start-processing').first()).toHaveText('Generating notes…')
  const startNext = page.getByRole('button', { name: 'Start Bluely' }).first()
  await expect(startNext).toBeEnabled()
  await shot(page, 'home-processing-dark')
  const starts = (await calls(ctx.app, 'session:start')).length
  await startNext.click()
  await expect(page.getByRole('button', { name: /Stop session/ }).first()).toBeVisible()
  expect((await calls(ctx.app, 'session:start')).length).toBe(starts + 1)

  // A start whose audio never comes up stays 'starting': it must still be stoppable here.
  await push(ctx.app, 'session:state', { ...IDLE, status: 'starting', sessionId: 'live-2' })
  const stopStarting = page.getByRole('button', { name: /Stop session/ }).first()
  await expect(stopStarting).toBeEnabled()
  await expect(stopStarting).toContainText('Starting…')
  const stops = (await calls(ctx.app, 'session:stop')).length
  await stopStarting.click()
  await expect.poll(async () => (await calls(ctx.app, 'session:stop')).length).toBe(stops + 1)
  await push(ctx.app, 'session:state', { ...IDLE })
  await expect(page.getByRole('button', { name: 'Start Bluely' }).first()).toBeVisible()
  await expect(page.getByTestId('start-processing')).toHaveCount(0)
})

test('"Restart & update" asks first, stops the call and installs only once its notes are written', async () => {
  const live = (status: LiveSessionState['status']): LiveSessionState => ({
    ...IDLE,
    status,
    sessionId: 'live-3',
    startedAt: Date.now() - 60_000,
  })
  await patchFake(ctx.app, { notices: NOTICES, live: live('live') })
  await page.reload()
  const install = page.getByRole('button', { name: 'Restart & update' })
  // The session status at each updater:install (main refuses unless it is idle).
  const installs = async () =>
    (await calls(ctx.app, 'updater:install:status')).map((c) => c.req as string)
  const stops = async () => (await calls(ctx.app, 'session:stop')).length
  /** The notes of the stopped call are done: main goes idle. */
  const notesWritten = async () => {
    await patchFake(ctx.app, { live: IDLE })
    await push(ctx.app, 'session:state', IDLE)
  }
  const stopsBefore = await stops()

  // A live call: ask first; Cancel changes nothing.
  await install.click()
  const dialog = page.getByRole('dialog', { name: 'Stop the call and restart?' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toHaveCount(0)
  expect(await stops()).toBe(stopsBefore)
  expect(await installs()).toEqual([])

  // Confirmed: the call stops (the fake then writes its notes), and Bluely installs only once
  // the notes are written, so quitting never abandons them.
  await install.click()
  await dialog.getByRole('button', { name: 'Stop call and restart' }).click()
  await expect.poll(stops).toBe(stopsBefore + 1)
  await expect(dialog).toBeVisible()
  await notesWritten()
  await expect.poll(installs).toEqual(['idle'])
  await expect(dialog).toHaveCount(0)

  // A call that is already stopping: its stop is awaited as well.
  await patchFake(ctx.app, { live: live('stopping') })
  await push(ctx.app, 'session:state', live('stopping'))
  await install.click()
  await dialog.getByRole('button', { name: 'Stop call and restart' }).click()
  await expect.poll(stops).toBe(stopsBefore + 2)
  await notesWritten()
  await expect.poll(installs).toEqual(['idle', 'idle'])

  // Notes being written: say Bluely restarts once they are done. Cancel while it waits means
  // no restart after all.
  await patchFake(ctx.app, { live: live('processing') })
  await install.click()
  const notesDialog = page.getByRole('dialog', { name: 'Restart once the notes are written?' })
  await expect(notesDialog).toBeVisible()
  await notesDialog.getByRole('button', { name: 'Restart when done' }).click()
  await notesDialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(notesDialog).toHaveCount(0)
  await notesWritten()

  // Idle: install right away (and nothing else installed in between).
  await install.click()
  await expect.poll(installs).toEqual(['idle', 'idle', 'idle'])
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('settings:open event and the avatar open the Settings slot', async () => {
  await push(ctx.app, 'settings:open', { page: 'models' })
  await expect(page.getByTestId('settings-page-models')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('settings-nav')).toHaveCount(0)
  await page.getByRole('button', { name: /^Settings/ }).click()
  await expect(page.getByTestId('settings-page-general')).toBeVisible()
  await page.keyboard.press('Escape')
})

test('first-run empty state with no key', async () => {
  await patchFake(ctx.app, {
    sessions: [],
    notices: [],
    live: IDLE,
    keyStatus: { hasKey: false, masked: null, encryptionAvailable: true },
  })
  await page.reload()
  await expect(page.getByTestId('home-empty')).toBeVisible()
  await expect(page.getByText('No meetings yet')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Add your OpenRouter key' })).toHaveCount(2)
  await bothThemes(page, 'home-empty-nokey')
  await page.getByRole('button', { name: 'Add your OpenRouter key' }).first().click()
  await expect(page.getByTestId('settings-page-models')).toBeVisible()
  await page.keyboard.press('Escape')
})

test('window controls are wired', async () => {
  // Xvfb has no window manager, so record the calls instead of really maximizing.
  await ctx.app.evaluate(({ ipcMain, BrowserWindow }) => {
    const g = globalThis as unknown as { __calls: { ch: string; req: unknown }[] }
    let max = false
    for (const ch of ['window:toggleMaximize', 'window:minimize', 'window:close']) {
      ipcMain.removeHandler(ch)
      ipcMain.handle(ch, () => {
        g.__calls.push({ ch, req: null })
        if (ch !== 'window:toggleMaximize') return { ok: true, data: undefined }
        max = !max
        for (const w of BrowserWindow.getAllWindows()) w.webContents.send('window:maximized', max)
        return { ok: true, data: max }
      })
    }
  })
  await page.getByRole('button', { name: 'Maximize' }).click()
  await expect(page.getByRole('button', { name: 'Restore' })).toBeVisible()
  await page.getByRole('button', { name: 'Restore' }).click()
  await expect(page.getByRole('button', { name: 'Maximize' })).toBeVisible()
  await page.getByRole('button', { name: 'Minimize' }).click()
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  expect((await calls(ctx.app, 'window:toggleMaximize')).length).toBe(2)
  expect((await calls(ctx.app, 'window:minimize')).length).toBe(1)
  expect((await calls(ctx.app, 'window:close')).length).toBe(1)
})
