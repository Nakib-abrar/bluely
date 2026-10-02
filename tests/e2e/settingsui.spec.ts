/**
 * Settings sheet + onboarding (slice `settingsui`).
 *
 * Renders the components through the dev-only preview page (src/renderer/settings/preview.html,
 * built when BLUELY_PREVIEW=1; this spec builds it if missing) inside the real main window, with
 * the main-process backend faked per channel. Chromium's fake media devices stand in for a mic.
 *
 * Set BLUELY_SHOTS_DIR=/some/dir to also save dark + light screenshots of every page.
 */
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BUILTIN_MODES } from '../../src/shared/builtinModes'
import type {
  KeybindStatus,
  KnowledgeFile,
  Mode,
  ModelInfo,
  ModelStat,
} from '../../src/shared/types'

const ROOT = join(__dirname, '..', '..')
const PREVIEW_HTML = join(ROOT, 'out', 'renderer', 'settings', 'preview.html')
const PREVIEW_URL = 'bluely://app/settings/preview.html'
const SHOTS_DIR = process.env['BLUELY_SHOTS_DIR'] ?? null

// ───────────────────────────── fixtures ─────────────────────────────

function model(
  id: string,
  name: string,
  ctx: number,
  inPerM: number,
  outPerM: number,
  extra: Partial<ModelInfo> = {},
): ModelInfo {
  return {
    id,
    name,
    contextLength: ctx,
    pricing: {
      prompt: inPerM / 1_000_000,
      completion: outPerM / 1_000_000,
      request: null,
      image: null,
      audio: null,
    },
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportsVision: false,
    supportsAudioInput: false,
    isStt: false,
    description: null,
    ...extra,
  }
}

const vision = { supportsVision: true, inputModalities: ['text', 'image'] }
const MODELS: ModelInfo[] = [
  model('meta-llama/llama-3.3-70b-instruct', 'Meta: Llama 3.3 70B Instruct', 131072, 0.13, 0.4),
  model('openai/gpt-oss-120b', 'OpenAI: gpt-oss-120b', 131072, 0.09, 0.45),
  model('google/gemini-2.5-flash', 'Google: Gemini 2.5 Flash', 1048576, 0.3, 2.5, {
    ...vision,
    supportsAudioInput: true,
    inputModalities: ['text', 'image', 'audio'],
  }),
  model('google/gemini-2.5-flash-lite', 'Google: Gemini 2.5 Flash Lite', 1048576, 0.1, 0.4, vision),
  model('openai/gpt-4.1-mini', 'OpenAI: GPT-4.1 Mini', 1047576, 0.4, 1.6, vision),
  model('anthropic/claude-haiku-4.5', 'Anthropic: Claude Haiku 4.5', 200000, 1, 5, vision),
  model('anthropic/claude-sonnet-4.5', 'Anthropic: Claude Sonnet 4.5', 1000000, 3, 15, vision),
  model('openai/gpt-4o-mini', 'OpenAI: GPT-4o-mini', 128000, 0.15, 0.6, vision),
  model('meta-llama/llama-3.1-8b-instruct', 'Meta: Llama 3.1 8B Instruct', 131072, 0.02, 0.03),
  model('qwen/qwen3-32b', 'Qwen: Qwen3 32B', 40960, 0, 0),
  model('openai/whisper-large-v3-turbo', 'OpenAI: Whisper Large v3 Turbo', 0, 0, 0, {
    isStt: true,
    supportsAudioInput: true,
    inputModalities: ['audio'],
    pricing: { prompt: null, completion: null, request: null, image: null, audio: 0.00004 },
  }),
  model('mistralai/voxtral-small-24b-2507', 'Mistral: Voxtral Small 24B', 32000, 0.1, 0.3, {
    isStt: true,
    supportsAudioInput: true,
    inputModalities: ['text', 'audio'],
  }),
]

const STATS: ModelStat[] = [
  {
    model: 'meta-llama/llama-3.3-70b-instruct',
    provider: 'Groq',
    samples: 42,
    ttftP50: 212,
    ttftP90: 388,
    totalP50: 940,
    tokensPerSecP50: 276,
    updatedAt: 1,
  },
  {
    model: 'google/gemini-2.5-flash',
    provider: 'Google AI Studio',
    samples: 17,
    ttftP50: 512,
    ttftP90: 905,
    totalP50: 1840,
    tokensPerSecP50: 168,
    updatedAt: 1,
  },
  {
    model: 'anthropic/claude-sonnet-4.5',
    provider: 'Anthropic',
    samples: 6,
    ttftP50: 1310,
    ttftP90: 2210,
    totalP50: 6420,
    tokensPerSecP50: 61,
    updatedAt: 1,
  },
]

const CUSTOM_MODE: Mode = {
  id: 'custom-acme',
  name: 'Acme renewal calls',
  icon: '🛰️',
  tone: 'friendly',
  autoSuggest: true,
  modelOverrides: { smart: 'anthropic/claude-haiku-4.5' },
  isBuiltin: false,
  sort: 10,
  instructions:
    'Renewal conversations with Acme. Focus on usage growth and the upcoming price change.',
}

const FILES: KnowledgeFile[] = [
  {
    id: 'f1',
    modeId: 'builtin-sales',
    filename: 'Pricing sheet 2026.pdf',
    size: 1_284_000,
    status: 'parsed',
    error: null,
    chunkCount: 12,
    addedAt: 3,
  },
  {
    id: 'f2',
    modeId: 'builtin-sales',
    filename: 'Objection handling.docx',
    size: 86_400,
    status: 'parsing',
    error: null,
    chunkCount: 0,
    addedAt: 2,
  },
  {
    id: 'f3',
    modeId: 'builtin-sales',
    filename: 'scanned-contract.pdf',
    size: 4_800_000,
    status: 'failed',
    error: 'No text found (scanned PDF?)',
    chunkCount: 0,
    addedAt: 1,
  },
]

const KEYBIND_STATUS: KeybindStatus[] = [
  { id: 'toggleOverlay', accelerator: 'CommandOrControl+\\', registered: true, error: null },
  { id: 'askAssist', accelerator: 'CommandOrControl+Enter', registered: true, error: null },
  {
    id: 'actionRecap',
    accelerator: 'CommandOrControl+Shift+3',
    registered: false,
    error: 'Taken by another app',
  },
]

const FIXTURES = {
  models: MODELS,
  stats: STATS,
  modes: [...BUILTIN_MODES, CUSTOM_MODE],
  files: FILES,
  keybindStatus: KEYBIND_STATUS,
}

// ───────────────────────────── harness ─────────────────────────────

interface Call {
  channel: string
  payload: unknown
}

let app: ElectronApplication
let page: Page

/** Replaces main-process handlers with fakes that record every call. */
async function installFakes(target: ElectronApplication): Promise<void> {
  await target.evaluate(({ ipcMain, BrowserWindow }, fx) => {
    type Fake = (payload: Record<string, unknown>) => unknown
    const state = {
      calls: [] as { channel: string; payload: unknown }[],
      hasKey: false,
      modes: fx.modes.map((m) => ({ ...m })),
      files: fx.files.map((f) => ({ ...f })),
    }
    ;(globalThis as unknown as { __bluely: typeof state }).__bluely = state
    const send = (event: string, payload: unknown) => {
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send(event, payload)
    }
    const fake = (channel: string, fn: Fake) => {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (_e, payload: unknown) => {
        state.calls.push({ channel, payload })
        try {
          return { ok: true, data: await fn((payload ?? {}) as Record<string, unknown>) }
        } catch (err) {
          return { ok: false, error: { code: 'failed', message: String((err as Error).message) } }
        }
      })
    }
    const keyStatus = () => ({
      hasKey: state.hasKey,
      masked: state.hasKey ? 'sk-or-v1-…9f3c' : null,
      encryptionAvailable: true,
    })

    fake('app:getInfo', () => ({
      name: 'Bluely',
      version: '0.1.0',
      electron: '43.7.7',
      chrome: '140.0.7339.41',
      platform: 'win32',
      arch: 'x64',
      isPackaged: true,
      isPortable: false,
      dataDir: 'C:\\Users\\Nadia\\AppData\\Roaming\\Bluely',
      devMode: false,
    }))
    fake('app:openExternal', () => true)
    fake('app:openDataFolder', () => undefined)
    fake('app:quit', () => undefined)
    fake('updater:getStatus', () => ({
      state: 'idle',
      version: null,
      progress: null,
      error: null,
      releaseUrl: null,
    }))
    fake('updater:check', () => ({
      state: 'available',
      version: '0.2.0',
      progress: null,
      error: null,
      releaseUrl: null,
    }))
    fake('updater:download', () => {
      send('updater:status', {
        state: 'downloading',
        version: '0.2.0',
        progress: 42,
        error: null,
        releaseUrl: null,
      })
    })
    fake('key:getStatus', keyStatus)
    fake('key:set', () => {
      state.hasKey = true
      return keyStatus()
    })
    fake('key:clear', () => {
      state.hasKey = false
      return keyStatus()
    })
    fake('key:test', () => ({
      ok: true,
      label: 'bluely',
      limit: 20,
      usage: 3.21,
      remaining: 16.79,
      isFreeTier: false,
      latencyMs: 210,
      error: null,
    }))
    fake('models:list', () => fx.models)
    fake('models:validateDefaults', () => [
      {
        role: 'notes',
        requested: 'anthropic/claude-sonnet-4.5',
        resolved: 'anthropic/claude-sonnet-4.5',
        replaced: false,
        reason: null,
      },
      {
        role: 'stt',
        requested: 'openai/whisper-large-v3-turbo',
        resolved: 'mistralai/voxtral-small-24b-2507',
        replaced: true,
        reason: 'OpenRouter does not list it right now.',
      },
    ])
    fake('models:getStats', () => fx.stats)
    fake('models:runLatencyTest', (p) => {
      const models = p['models'] as string[]
      const runId = 'run-1'
      models.forEach((m, i) => {
        for (let done = 1; done <= 5; done++) {
          setTimeout(
            () => {
              const stat = fx.stats.find((s) => s.model === m) ?? {
                model: m,
                provider: 'DeepInfra',
                samples: 5,
                ttftP50: 640,
                ttftP90: 1020,
                totalP50: 2100,
                tokensPerSecP50: 118,
                updatedAt: 1,
              }
              send('models:latencyProgress', {
                runId,
                model: m,
                completed: done,
                total: 5,
                result: done === 5 ? { ...stat, samples: 5 } : null,
                errors: [],
              })
            },
            150 + i * 60 + done * 80,
          )
        }
      })
      return { runId }
    })
    fake('usage:getMonthSpend', () => ({
      sinceMs: 0,
      totalUsd: 0.42,
      llmUsd: 0.31,
      sttUsd: 0.11,
      requests: 128,
    }))
    fake('modes:list', () => state.modes)
    fake('modes:setActive', () => undefined)
    fake('modes:update', (p) => {
      const mode = state.modes.find((m) => m.id === p['id'])
      if (!mode) throw new Error('No such mode')
      Object.assign(mode, p['patch'])
      return { ...mode }
    })
    fake('modes:create', (p) => {
      const mode = {
        ...(p as object),
        id: `custom-${state.modes.length}`,
        isBuiltin: false,
        sort: 99,
      }
      state.modes.push(mode as (typeof state.modes)[number])
      return mode
    })
    fake('modes:delete', (p) => {
      state.modes = state.modes.filter((m) => m.id !== p['id'])
    })
    fake('modes:resetBuiltin', (p) => state.modes.find((m) => m.id === p['id']))
    fake('knowledge:list', (p) => state.files.filter((f) => f.modeId === p['modeId']))
    fake('knowledge:pickAndAdd', (p) => {
      const file = {
        id: `f${state.files.length + 1}`,
        modeId: String(p['modeId']),
        filename: 'Product one-pager.md',
        size: 4200,
        status: 'pending' as const,
        error: null,
        chunkCount: 0,
        addedAt: Date.now(),
      }
      state.files.push(file)
      setTimeout(() => {
        send('knowledge:changed', {
          modeId: file.modeId,
          files: state.files
            .filter((f) => f.modeId === file.modeId)
            .map((f) => (f.id === file.id ? { ...f, status: 'parsed', chunkCount: 3 } : f)),
        })
      }, 300)
      return [file]
    })
    fake('knowledge:delete', (p) => {
      state.files = state.files.filter((f) => f.id !== p['fileId'])
    })
    fake('keybinds:getStatus', () => fx.keybindStatus)
    fake('data:exportAll', () => ({
      path: 'C:\\Users\\Nadia\\Documents\\Bluely export 2026-10-02.zip',
    }))
    fake('data:deleteAll', () => undefined)
    fake('audio:testTranscribe', (p) => {
      const wav = p['wav'] as Uint8Array
      const riff = String.fromCharCode(...Array.from(wav.slice(0, 4)))
      const rate = wav[24]! | (wav[25]! << 8) | (wav[26]! << 16)
      return {
        text: `Testing one two three (${riff} ${rate} Hz, ${wav.byteLength} bytes)`,
        latencyMs: 820,
        model: 'openai/whisper-large-v3-turbo',
      }
    })
    fake('session:start', () => ({ sessionId: 'session-1' }))
  }, FIXTURES)
}

async function calls(channel: string): Promise<Call[]> {
  return app.evaluate((_electron, ch) => {
    const state = (globalThis as unknown as { __bluely: { calls: Call[] } }).__bluely
    return state.calls.filter((c) => c.channel === ch)
  }, channel)
}

async function settingsNow() {
  return page.evaluate(async () => {
    const res = await window.bluely.invoke('settings:get', undefined)
    if (!res.ok) throw new Error(res.error.message)
    return res.data
  })
}

async function setTheme(theme: 'dark' | 'light') {
  await page.evaluate(
    (t) => window.bluely.invoke('settings:update', { patch: { general: { theme: t } } }),
    theme,
  )
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
}

async function go(hash: string) {
  await page.evaluate((h) => {
    location.hash = h
  }, hash)
}

async function shot(name: string) {
  if (!SHOTS_DIR) return
  await page.waitForTimeout(250)
  await page.screenshot({ path: join(SHOTS_DIR, `${name}.png`) })
}

const content = () => page.locator('[data-testid^="settings-page-"]')

test.describe.configure({ mode: 'serial', timeout: 180_000 })

test.beforeAll(async () => {
  if (!existsSync(PREVIEW_HTML)) {
    execSync('pnpm exec electron-vite build', {
      cwd: ROOT,
      env: { ...process.env, BLUELY_PREVIEW: '1' },
      stdio: 'inherit',
    })
  }
  if (SHOTS_DIR) mkdirSync(SHOTS_DIR, { recursive: true })
  const userData = mkdtempSync(join(tmpdir(), 'bluely-e2e-settings-'))
  const args = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '.']
  if (process.platform === 'linux' && process.getuid?.() === 0) args.unshift('--no-sandbox')
  app = await electron.launch({
    args,
    cwd: ROOT,
    env: { ...process.env, BLUELY_USER_DATA_DIR: userData, BLUELY_TEST: '1' } as Record<
      string,
      string
    >,
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await installFakes(app)
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    win?.setSize(1180, 800)
    win?.center()
  })
  await page.goto(`${PREVIEW_URL}#settings/general`)
  await expect(page.getByTestId('settings-nav')).toBeVisible()
})

test.afterAll(async () => {
  await app?.close()
})

test('sheet layout: nav, close, support group and page switching', async () => {
  const nav = page.getByTestId('settings-nav')
  for (const label of [
    'General',
    'AI Models',
    'Modes',
    'Keybinds',
    'Profile',
    'Language',
    'Privacy & Data',
    'Release notes',
    'Help',
    'Report an issue',
    'Quit Bluely',
  ]) {
    await expect(nav.getByRole('button', { name: label, exact: true })).toBeVisible()
  }
  await expect(nav.getByText('Support', { exact: true })).toBeVisible()
  await expect(page.getByTestId('settings-nav-general')).toHaveAttribute('aria-current', 'page')

  await page.getByTestId('settings-nav-profile').click()
  await expect(page.getByTestId('settings-page-profile')).toBeVisible()
  await expect(page.getByTestId('settings-nav-profile')).toHaveAttribute('aria-current', 'page')

  // Report an issue opens the issues URL; it is not a page.
  await nav.getByRole('button', { name: 'Report an issue' }).click()
  await expect
    .poll(async () => (await calls('app:openExternal')).at(-1)?.payload)
    .toEqual({
      url: 'https://github.com/nakib-abrar/bluely/issues/new/choose',
    })

  // Close button and Esc both close; the preview reopens it.
  await page.getByRole('button', { name: 'Close settings' }).click()
  await expect(page.getByTestId('settings-nav')).toBeHidden()
  await go('#settings/general')
  await expect(page.getByTestId('settings-nav')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('settings-nav')).toBeHidden()
  await go('#settings/general')
  await expect(page.getByTestId('settings-nav')).toBeVisible()
})

test('general: version, update flow, theme, toggles and advanced', async () => {
  await go('#settings/general')
  const c = content()
  await expect(c.getByTestId('app-version')).toHaveText('You are using Bluely 0.1.0')
  await shot('general-dark')

  await c.getByRole('button', { name: 'Check for updates' }).click()
  await expect(c.getByTestId('update-status')).toContainText('Bluely 0.2.0 is available')
  await c.getByRole('button', { name: 'Download' }).click()
  await expect(c.getByTestId('update-status')).toContainText('Downloading update… 42%')

  await c.getByRole('combobox', { name: 'Color theme' }).click()
  await page.getByRole('option', { name: 'Light' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  expect((await settingsNow()).general.theme).toBe('light')
  await setTheme('dark')

  const consent = c.getByRole('switch', { name: 'Consent reminder' })
  await expect(consent).toBeChecked()
  await consent.click()
  await expect.poll(async () => (await settingsNow()).general.consentReminder).toBe(false)
  await consent.click()
  await expect.poll(async () => (await settingsNow()).general.consentReminder).toBe(true)

  // Active Mode row (the Bluely equivalent of the reference's "Detectable" row).
  await c.getByRole('combobox', { name: 'Active Mode' }).click()
  await page.getByRole('option', { name: /Sales call/ }).click()
  await expect
    .poll(async () => (await calls('modes:setActive')).at(-1)?.payload)
    .toEqual({
      id: 'builtin-sales',
    })

  // Advanced is collapsed by default; sliders save on commit.
  await expect(c.getByRole('slider', { name: 'Max segment length' })).toBeHidden()
  await c.getByRole('button', { name: /Advanced/ }).click()
  const slider = c.getByRole('slider', { name: 'Max segment length' })
  await expect(slider).toBeVisible()
  await slider.focus()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await expect.poll(async () => (await settingsNow()).advanced.maxSegmentSec).toBe(14)
  await expect(c.getByText('14 s')).toBeVisible()
  await c.getByRole('button', { name: 'Reset advanced' }).click()
  await expect.poll(async () => (await settingsNow()).advanced.maxSegmentSec).toBe(12)
  await c.evaluate((el) => el.scrollTo({ top: el.scrollHeight }))
  await shot('general-advanced-dark')
})

test('general: microphone list, mic test (record → WAV → transcribe), system audio', async () => {
  await go('#settings/general')
  const c = content()
  const mic = c.getByRole('combobox', { name: 'Microphone' })
  await expect(mic).toContainText('System default')
  await mic.click()
  const options = page.getByRole('option')
  await expect(options.first()).toBeVisible()
  const count = await options.count()
  expect(count).toBeGreaterThan(1) // fake devices + "System default"
  await options.nth(1).click()
  await expect.poll(async () => (await settingsNow()).audio.micDeviceId).not.toBeNull()

  await c.getByRole('button', { name: 'Test microphone' }).click()
  await expect(c.getByRole('meter', { name: 'Input level' })).toBeVisible()
  await expect(c.getByText(/Say something…/)).toBeVisible()
  await shot('general-mic-recording-dark')
  // 5 s recording, then the WAV goes to main for transcription.
  await expect(c.getByTestId('mic-test')).toContainText('Testing one two three', {
    timeout: 20_000,
  })
  await expect(c.getByTestId('mic-test')).toContainText('RIFF 16000 Hz')
  await expect(c.getByTestId('mic-test')).toContainText('820 ms · openai/whisper-large-v3-turbo')
  const sent = await calls('audio:testTranscribe')
  expect(sent).toHaveLength(1)

  // System audio: the result is environment dependent (no loopback in CI); either way it reports.
  await c.getByRole('button', { name: 'Test system audio' }).click()
  await expect(c.getByTestId('system-audio-result')).toBeVisible({ timeout: 15_000 })
  await expect(c.getByText('Use headphones for the cleanest transcript')).toBeVisible()
  await c.getByTestId('mic-test').scrollIntoViewIfNeeded()
  await shot('general-audio-dark')
  // Back to the system default for the remaining tests.
  await page.evaluate(() =>
    window.bluely.invoke('settings:update', {
      patch: { audio: { micDeviceId: null, micLabel: null } },
    }),
  )
})

test('ai models: key save + test, pickers filter by role, routing, latency test, spend', async () => {
  await go('#settings/models')
  const c = content()
  await expect(c.getByTestId('key-status')).toHaveText('No key saved yet')
  await expect(c.getByRole('button', { name: 'Test connection' })).toBeDisabled()
  await shot('models-dark')

  await c.getByLabel('OpenRouter API key').fill('sk-or-v1-0123456789abcdef9f3c')
  await c.getByRole('button', { name: 'Save key' }).click()
  await expect(c.getByTestId('key-status')).toHaveText('Saved · sk-or-v1-…9f3c')
  await expect(c.getByTestId('key-test-result')).toHaveText(
    'Connected · $16.79 remaining of $20.00 · 210 ms',
  )
  expect((await calls('key:set'))[0]?.payload).toEqual({ key: 'sk-or-v1-0123456789abcdef9f3c' })

  await c.getByRole('button', { name: 'Get a key' }).click()
  await expect
    .poll(async () => (await calls('app:openExternal')).at(-1)?.payload)
    .toEqual({
      url: 'https://openrouter.ai/keys',
    })

  // Smart lists only vision models.
  await c.getByRole('button', { name: 'Smart model' }).click()
  const list = page.getByRole('listbox', { name: 'Smart model' })
  await expect(list.getByRole('option', { name: /Gemini 2\.5 Flash Lite/ })).toBeVisible()
  await expect(list.getByRole('option', { name: /Llama 3\.3 70B/ })).toHaveCount(0)
  await expect(list.getByRole('option', { name: /Whisper/ })).toHaveCount(0)
  await shot('models-picker-dark')
  await page.keyboard.type('haiku')
  await expect(list.getByRole('option')).toHaveCount(1)
  await page.keyboard.press('Enter')
  await expect
    .poll(async () => (await settingsNow()).models.smart.model)
    .toBe('anthropic/claude-haiku-4.5')

  // STT lists only speech-to-text models.
  await c.getByRole('button', { name: 'Speech-to-text model' }).click()
  const stt = page.getByRole('listbox', { name: 'Speech-to-text model' })
  await expect(stt.getByRole('option')).toHaveCount(2)
  await page.keyboard.press('Escape')

  // Routing: sort + pinned providers + fallbacks.
  await c.getByRole('combobox', { name: 'Fast: Prefer' }).click()
  await page.getByRole('option', { name: 'Lowest price' }).click()
  await expect.poll(async () => (await settingsNow()).models.fast.sort).toBe('price')
  const pin = c.locator('#pin-fast')
  await pin.fill('Groq,  cerebras, groq')
  await pin.press('Enter')
  await expect
    .poll(async () => (await settingsNow()).models.fast.order)
    .toEqual(['groq', 'cerebras'])
  await c.getByRole('switch', { name: 'Notes: Allow fallbacks' }).click()
  await expect.poll(async () => (await settingsNow()).models.notes.allowFallbacks).toBe(false)

  // Latency test with progress events.
  const run = c.getByRole('button', { name: 'Run latency test' })
  await run.scrollIntoViewIfNeeded()
  await run.click()
  const table = c.getByTestId('latency-table')
  await expect(table).toContainText('212 ms', { timeout: 10_000 })
  await expect(table).toContainText('Groq')
  await expect(c.getByRole('button', { name: 'Run latency test' })).toBeEnabled()
  const req = (await calls('models:runLatencyTest'))[0]?.payload as { models: string[] }
  expect(req.models).toContain('meta-llama/llama-3.3-70b-instruct')
  await expect(c.getByTestId('month-spend')).toContainText('$0.42 this month')
  await expect(c.getByTestId('month-spend')).toContainText(
    'LLM $0.31 · Transcription $0.11 · 128 requests',
  )
  await expect(c.getByTestId('rolling-table')).toContainText('Anthropic')
  await table.scrollIntoViewIfNeeded()
  await shot('models-latency-dark')
})

test('modes: list, autosaving editor, files, create and delete', async () => {
  await go('#settings/modes')
  const c = content()
  const list = c.getByTestId('mode-list')
  await expect(list.getByRole('button')).toHaveCount(7)
  await list.getByRole('button', { name: /Sales call/ }).click()
  await expect(c.getByLabel('Name')).toHaveValue('Sales call')
  const files = c.getByTestId('knowledge-list')
  await expect(files).toContainText('Pricing sheet 2026.pdf')
  await expect(files).toContainText('12 chunks')
  await expect(files).toContainText('Parsing…')
  await expect(files).toContainText('No text found (scanned PDF?)')
  await shot('modes-dark')

  await c.getByLabel('Instructions').fill('Sell the annual plan. Be honest about limits.')
  await expect
    .poll(async () => (await calls('modes:update')).at(-1)?.payload)
    .toEqual({
      id: 'builtin-sales',
      patch: { instructions: 'Sell the annual plan. Be honest about limits.' },
    })
  await expect(c.getByText('Saved', { exact: true })).toBeVisible()

  // Drag feedback. (A synthetic File has no disk path, so the drop itself sends nothing.)
  const drop = c.getByTestId('knowledge-dropzone')
  const dataTransfer = await page.evaluateHandle(() => {
    const dt = new DataTransfer()
    dt.items.add(new File(['hello'], 'notes.txt', { type: 'text/plain' }))
    return dt
  })
  await drop.dispatchEvent('dragenter', { dataTransfer })
  await expect(drop).toContainText('Release to add files')
  await drop.dispatchEvent('drop', { dataTransfer })
  await expect(drop).toContainText('Drop files here')
  expect(await calls('knowledge:addPaths')).toHaveLength(0)

  await c.getByRole('button', { name: 'Upload files' }).click()
  await expect(files).toContainText('Product one-pager.md')
  await expect(files.getByText('3 chunks')).toBeVisible()
  await c.getByRole('button', { name: 'Remove Pricing sheet 2026.pdf' }).click()
  await expect(files).not.toContainText('Pricing sheet 2026.pdf')

  await list.getByRole('button', { name: /Team standup/ }).click()
  await c.getByRole('button', { name: 'Set as active' }).click()
  await expect(c.getByTestId('mode-editor').getByText('Active', { exact: true })).toBeVisible()
  await expect
    .poll(async () => (await calls('modes:setActive')).at(-1)?.payload)
    .toEqual({
      id: 'builtin-standup',
    })

  await c.getByRole('button', { name: 'New Mode' }).click()
  await expect(c.getByLabel('Name')).toHaveValue('Untitled Mode')
  await expect(c.getByLabel('Name')).toBeFocused()
  await c.getByRole('button', { name: 'Delete Mode' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete Mode' }).click()
  await expect(list.getByRole('button')).toHaveCount(7)

  await list.getByRole('button', { name: /Acme renewal calls/ }).click()
  await expect(c.getByRole('button', { name: 'Smart model' })).toContainText('Claude Haiku 4.5')
  await shot('modes-custom-dark')
})

test('keybinds: capture, conflicts, disable, Alt+Enter preset, reset', async () => {
  await go('#settings/keybinds')
  const c = content()
  const ask = c.getByTestId('keybind-askAssist')
  await expect(ask).toContainText('Ask Bluely / Assist')
  await expect(c.getByTestId('keybind-actionRecap')).toContainText('Taken by another app')
  await shot('keybinds-dark')

  // Conflict: Ctrl+Shift+1 belongs to "What should I say?" → error, not saved, stays in capture.
  await ask.getByRole('button', { name: 'Rebind' }).click()
  await expect(ask).toContainText('Press the new shortcut… (Esc to cancel)')
  await page.keyboard.press('Control+Shift+Digit1')
  await expect(ask).toContainText('is already used by “What should I say?”')
  expect((await settingsNow()).keybinds.askAssist).toBe('CommandOrControl+Enter')
  await shot('keybinds-capture-dark')
  // Esc cancels capture without closing the sheet.
  await page.keyboard.press('Escape')
  await expect(ask).not.toContainText('Press the new shortcut')
  await expect(page.getByTestId('settings-nav')).toBeVisible()

  // Valid new bind.
  await ask.getByRole('button', { name: 'Rebind' }).click()
  await page.keyboard.press('Alt+Shift+KeyK')
  await expect.poll(async () => (await settingsNow()).keybinds.askAssist).toBe('Alt+Shift+K')

  // Reserved combos are refused.
  await ask.getByRole('button', { name: 'Rebind' }).click()
  await page.keyboard.press('Control+KeyC')
  await expect(ask).toContainText('is reserved')
  await page.keyboard.press('Escape')

  // Disable / enable.
  await c.getByRole('switch', { name: 'Enable Recap' }).click()
  await expect.poll(async () => (await settingsNow()).keybinds.actionRecap).toBeNull()
  await expect(c.getByTestId('keybind-actionRecap')).toContainText('Disabled')
  await c.getByRole('switch', { name: 'Enable Recap' }).click()
  await expect
    .poll(async () => (await settingsNow()).keybinds.actionRecap)
    .toBe('CommandOrControl+Shift+3')

  // Alt+Enter preset.
  await c.getByRole('button', { name: 'Use Alt+Enter' }).click()
  await expect.poll(async () => (await settingsNow()).keybinds.askAssist).toBe('Alt+Enter')
  await expect(c.getByRole('button', { name: 'Using Alt+Enter' })).toBeDisabled()

  await c.getByRole('button', { name: 'Reset all to defaults' }).click()
  await expect
    .poll(async () => (await settingsNow()).keybinds.askAssist)
    .toBe('CommandOrControl+Enter')
})

test('profile, language and privacy pages', async () => {
  await go('#settings/profile')
  let c = content()
  await c.getByLabel('Your name').fill('Nadia Rahman')
  await c.getByLabel('Role').fill('Account executive')
  await c
    .getByLabel('About me and my goals')
    .fill('I sell analytics software to mid-size retailers.')
  await expect
    .poll(async () => (await settingsNow()).profile)
    .toMatchObject({
      name: 'Nadia Rahman',
      role: 'Account executive',
      about: 'I sell analytics software to mid-size retailers.',
    })
  await expect(c.getByText('Saved', { exact: true })).toBeVisible()
  await shot('profile-dark')

  await go('#settings/language')
  c = content()
  await c.getByRole('combobox', { name: 'Transcription language' }).click()
  await page.getByRole('option', { name: 'Bangla (Bengali)' }).click()
  await expect.poll(async () => (await settingsNow()).language.transcription).toBe('bn')
  await c.getByRole('combobox', { name: 'Answer language' }).click()
  await page.getByRole('option', { name: 'English' }).click()
  await expect.poll(async () => (await settingsNow()).language.answer).toBe('en')
  await shot('language-dark')

  await go('#settings/privacy')
  c = content()
  await expect(c.getByTestId('data-dir')).toHaveText('C:\\Users\\Nadia\\AppData\\Roaming\\Bluely')
  await c.getByRole('button', { name: 'Open folder' }).click()
  await expect.poll(async () => (await calls('app:openDataFolder')).length).toBe(1)
  await c.getByRole('combobox', { name: 'Keep sessions' }).click()
  await page.getByRole('option', { name: '90 days' }).click()
  await expect.poll(async () => (await settingsNow()).privacy.retentionDays).toBe(90)
  await c.getByRole('button', { name: 'Export…' }).click()
  await expect(c.getByText(/Saved to C:\\Users\\Nadia\\Documents/)).toBeVisible()
  await expect(c.getByTestId('sent-list')).toContainText(
    'No Bluely servers, no accounts, no telemetry',
  )
  await shot('privacy-dark')

  await c.getByRole('button', { name: 'Delete all…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Delete all Bluely data?' })
  const confirm = dialog.getByRole('button', { name: 'Delete everything' })
  await expect(confirm).toBeDisabled()
  await dialog.getByLabel('Type DELETE to confirm').fill('delete')
  await expect(confirm).toBeDisabled()
  await dialog.getByLabel('Type DELETE to confirm').fill('DELETE')
  await shot('privacy-delete-dark')
  await confirm.click()
  await expect
    .poll(async () => (await calls('data:deleteAll')).at(-1)?.payload)
    .toEqual({
      confirm: 'DELETE',
    })
  await expect(c.getByText('All data deleted.')).toBeVisible()
})

test('release notes, help and quit', async () => {
  await go('#settings/releaseNotes')
  let c = content()
  await expect(c.getByTestId('release-0.1.0')).toContainText('Hello, Bluely')
  await expect(c.getByText('Installed')).toBeVisible()
  await shot('release-notes-dark')

  await go('#settings/help')
  c = content()
  await expect(c.getByTestId('app-info')).toContainText('Bluely 0.1.0')
  await c.getByRole('button', { name: 'Copy app info' }).click()
  await expect(c.getByRole('button', { name: 'Copied' })).toBeVisible()
  await shot('help-dark')

  await page.getByTestId('settings-quit').click()
  const dialog = page.getByRole('dialog', { name: 'Quit Bluely?' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Quit Bluely' }).click()
  await expect.poll(async () => (await calls('app:quit')).length).toBe(1)
  await page.keyboard.press('Escape')
})

test('light theme renders every page', async () => {
  test.skip(!SHOTS_DIR, 'screenshots only')
  await setTheme('light')
  for (const p of [
    'general',
    'models',
    'modes',
    'keybinds',
    'profile',
    'language',
    'privacy',
    'releaseNotes',
    'help',
  ]) {
    await go(`#settings/${p}`)
    await expect(page.getByTestId(`settings-page-${p}`)).toBeVisible()
    await shot(`${p}-light`)
  }
  await setTheme('dark')
})

test('onboarding: key → audio → mode, Alt+Enter preset, Start Bluely', async () => {
  await page.evaluate(() =>
    window.bluely.invoke('settings:update', {
      patch: {
        general: { onboardingComplete: false },
        keybinds: { askAssist: 'CommandOrControl+Enter' },
      },
    }),
  )
  await app.evaluate(() => {
    const state = (globalThis as unknown as { __bluely: { hasKey: boolean } }).__bluely
    state.hasKey = false
  })
  await go('#onboarding')
  const ob = page.getByTestId('onboarding')
  await expect(ob.getByText('Welcome to Bluely')).toBeVisible()
  await expect(ob.getByRole('button', { name: 'Next' })).toBeDisabled()
  await shot('onboarding-1-dark')

  await ob.getByLabel('OpenRouter API key').fill('sk-or-v1-onboarding-key-1234')
  await ob.getByRole('button', { name: 'Save key' }).click()
  await expect(ob.getByTestId('key-test-result')).toContainText('Connected')
  await expect(ob.getByRole('button', { name: 'Next' })).toBeEnabled()
  await shot('onboarding-1-done-dark')
  await ob.getByRole('button', { name: 'Next' }).click()

  await expect(page.getByTestId('onboarding-step-audio')).toBeVisible()
  await expect(ob.getByRole('button', { name: 'Test microphone' })).toBeVisible()
  await expect(ob.getByRole('button', { name: 'Test system audio' })).toBeVisible()
  await expect(ob.getByTestId('onboarding-ask-preset')).toContainText(
    'Ctrl+Enter is Bluely’s Ask shortcut',
  )
  await shot('onboarding-2-dark')
  await ob.getByRole('button', { name: /Use Alt\+Enter/ }).click()
  await expect.poll(async () => (await settingsNow()).keybinds.askAssist).toBe('Alt+Enter')
  await expect(ob.getByText('Ask is now Alt+Enter')).toBeVisible()
  await ob.getByRole('button', { name: 'Next' }).click()

  await expect(page.getByTestId('onboarding-step-mode')).toBeVisible()
  const modes = ob.getByTestId('onboarding-modes')
  await expect(modes.getByRole('radio')).toHaveCount(7)
  await modes.getByRole('radio', { name: /Client discovery/ }).click()
  await expect(modes.getByRole('radio', { name: /Client discovery/ })).toHaveAttribute(
    'aria-checked',
    'true',
  )
  await expect
    .poll(async () => (await calls('modes:setActive')).at(-1)?.payload)
    .toEqual({
      id: 'builtin-discovery',
    })
  await ob.getByLabel('Your name').fill('Nadia')
  await shot('onboarding-3-dark')

  await ob.getByRole('button', { name: 'Back' }).click()
  await expect(page.getByTestId('onboarding-step-audio')).toBeVisible()
  await ob.getByRole('button', { name: 'Next' }).click()

  await ob.getByRole('button', { name: 'Start Bluely' }).click()
  await expect(page.getByTestId('onboarding-done')).toBeVisible()
  const s = await settingsNow()
  expect(s.general.onboardingComplete).toBe(true)
  expect(s.profile.name).toBe('Nadia')
  expect(await calls('session:start')).toHaveLength(1)

  if (SHOTS_DIR) {
    await setTheme('light')
    await go('#onboarding')
    await shot('onboarding-1-light')
    await ob.getByRole('button', { name: 'Skip for now' }).click()
    await shot('onboarding-2-light')
    await ob.getByRole('button', { name: 'Next' }).click()
    await shot('onboarding-3-light')
    await setTheme('dark')
  }
})

test('degrades gracefully while backend features are not implemented', async () => {
  // Same answer the stub registry gives for channels no feature has claimed yet.
  await app.evaluate(({ ipcMain }) => {
    for (const channel of [
      'modes:list',
      'models:list',
      'models:getStats',
      'models:validateDefaults',
      'usage:getMonthSpend',
      'keybinds:getStatus',
      'updater:getStatus',
      'updater:check',
      'key:test',
    ]) {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, () => ({
        ok: false,
        error: { code: 'not_implemented', message: `${channel} is not implemented yet` },
      }))
    }
  })
  await page.reload()
  await go('#settings/general')
  let c = content()
  await c.getByRole('button', { name: 'Check for updates' }).click()
  await expect(c.getByTestId('update-status')).toContainText('Not available in this build yet.')
  // Active Mode falls back to the built-in names.
  await expect(c.getByRole('combobox', { name: 'Active Mode' })).toContainText('General meeting')

  await go('#settings/models')
  c = content()
  await expect(c.getByTestId('month-spend')).toContainText('Not available in this build yet.')
  await c.getByRole('button', { name: 'Fast model' }).click()
  await expect(page.getByRole('listbox', { name: 'Fast model' })).toContainText(
    'Could not load models',
  )
  await page.keyboard.press('Escape')
  await shot('models-unavailable-dark')

  await go('#settings/modes')
  c = content()
  await expect(c.getByText(/Could not load Modes/)).toBeVisible()
  await expect(c.getByRole('button', { name: 'Retry' })).toBeVisible()
  await shot('modes-unavailable-dark')

  await go('#settings/keybinds')
  await expect(content().getByTestId('keybind-askAssist')).toBeVisible()
})
