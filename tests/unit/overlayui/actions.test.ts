import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiCard, LiveSessionState } from '@shared/types'

interface Call {
  channel: string
  payload: unknown
}

const calls: Call[] = []
/** Channels that should fail, with the error envelope main would send. */
const failures = new Map<string, { code: string; message: string; ai?: unknown }>()
/** Response data per channel (default: ai:run → { id }, everything else → null). */
const responses = new Map<string, unknown>()

vi.stubGlobal('window', {
  bluely: {
    invoke: async (channel: string, payload: unknown) => {
      calls.push({ channel, payload })
      const error = failures.get(channel)
      if (error) return { ok: false, error }
      if (responses.has(channel)) return { ok: true, data: responses.get(channel) }
      return { ok: true, data: channel === 'ai:run' ? { id: 'x' } : null }
    },
    on: () => () => undefined,
    platform: 'win32',
  },
  // Imported via the settings store (theme.ts); never used by these tests.
  matchMedia: () => ({ matches: true, addEventListener: () => undefined }),
})

const actions = await import('../../../src/renderer/overlay/actions')
const { useUi } = await import('../../../src/renderer/overlay/stores/uiStore')
const { useLive, IDLE_STATE } = await import('../../../src/renderer/overlay/stores/liveStore')
const { useSettings } = await import('../../../src/renderer/stores/settings')
const { watchCaptureSettings, retryCapture } =
  await import('../../../src/renderer/overlay/hooks/useCapture')
const { createCapture } = await import('../../../src/renderer/overlay/capture')
const { CaptureController } = await import('../../../src/renderer/audio/captureController')

const runs = () => calls.filter((c) => c.channel === 'ai:run').map((c) => c.payload)
const flush = () => new Promise((r) => setTimeout(r, 0))

function failedCard(patch: Partial<AiCard>): AiCard {
  return {
    id: 'f1',
    scope: 'live',
    sessionId: 's1',
    kind: 'ask',
    label: 'Q?',
    question: 'Q?',
    usedScreen: true,
    tier: 'fast',
    status: 'error',
    text: '',
    error: { code: 'server', message: 'x', retryable: true },
    stats: null,
    citations: [],
    createdAt: 1,
    ...patch,
  }
}

beforeEach(() => {
  calls.length = 0
  failures.clear()
  responses.clear()
  useUi.setState({
    expanded: true,
    tab: 'insights',
    draft: '',
    screenForAssist: true,
    screenForQuestions: false,
    notice: null,
    unseen: 0,
  })
  const s = useSettings.getState().settings
  useSettings.setState({ settings: { ...s, models: { ...s.models, activeTier: 'smart' } } })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('overlay actions → ai:run payloads', () => {
  it('Assist uses the Assist screen toggle and the active tier', async () => {
    await actions.runAssist()
    useUi.getState().toggleScreen('assist')
    const s = useSettings.getState().settings
    useSettings.setState({ settings: { ...s, models: { ...s.models, activeTier: 'fast' } } })
    await actions.runAction('assist')
    expect(runs()).toEqual([
      { kind: 'assist', includeScreen: true, tier: 'smart' },
      { kind: 'assist', includeScreen: false, tier: 'fast' },
    ])
  })

  it('action buttons omit the tier (main uses Fast)', async () => {
    for (const kind of ['say', 'followups', 'recap', 'factcheck', 'who'] as const) {
      await actions.runAction(kind)
    }
    expect(runs()).toEqual([
      { kind: 'say' },
      { kind: 'followups' },
      { kind: 'recap' },
      { kind: 'factcheck' },
      { kind: 'who' },
    ])
  })

  it('typed questions use the question screen toggle; blank questions are ignored', async () => {
    await actions.askQuestion('   ')
    await actions.askQuestion('  What is the budget?  ')
    expect(runs()).toEqual([
      { kind: 'ask', question: 'What is the budget?', includeScreen: false, tier: 'smart' },
    ])
  })

  it('submitDraft asks the draft (and clears it) or runs Assist when empty', async () => {
    useUi.getState().setDraft('Summarize')
    await actions.submitDraft()
    expect(useUi.getState().draft).toBe('')
    await actions.submitDraft()
    expect(runs()).toEqual([
      { kind: 'ask', question: 'Summarize', includeScreen: false, tier: 'smart' },
      { kind: 'assist', includeScreen: true, tier: 'smart' },
    ])
  })

  it('running something switches to Insights and expands the panel', async () => {
    useUi.setState({ tab: 'transcript', expanded: false })
    await actions.runAction('recap')
    expect(useUi.getState().tab).toBe('insights')
    expect(useUi.getState().expanded).toBe(true)
    expect(calls.map((c) => c.channel)).toContain('overlay:setExpanded')
  })

  it('retry re-runs the same request and removes the failed card', async () => {
    useLive.getState().upsertCard(failedCard({}))
    await actions.retryCard(failedCard({}))
    await actions.retryCard(failedCard({ id: 'f2', kind: 'assist', usedScreen: false }))
    await actions.retryCard(failedCard({ id: 'f3', kind: 'auto' }))
    await actions.retryCard(failedCard({ id: 'f4', kind: 'who' }))
    expect(runs()).toEqual([
      { kind: 'ask', question: 'Q?', includeScreen: true, tier: 'fast' },
      { kind: 'assist', includeScreen: false, tier: 'fast' },
      { kind: 'say' },
      { kind: 'who' },
    ])
    expect(useLive.getState().cards.find((c) => c.id === 'f1')).toBeUndefined()
  })
})

describe('overlay actions: errors and shortcuts', () => {
  it('shows a notice (with a Settings link) when a request fails before a card exists', async () => {
    failures.set('ai:run', {
      code: 'no_key',
      message: 'no key',
      ai: { code: 'no_key', message: 'Add your key', retryable: false },
    })
    await actions.runAssist()
    expect(useUi.getState().notice).toMatchObject({
      message: 'Add your key',
      settingsPage: 'models',
    })
  })

  it('not_implemented is reported as unavailable', async () => {
    failures.set('ai:run', { code: 'not_implemented', message: 'ai:run is not implemented yet' })
    await actions.runAction('say')
    expect(useUi.getState().notice?.message).toBe('That isn’t available yet.')
  })

  it('Ctrl+Enter seen locally and as a global command only runs once', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(100_000)
    actions.assistShortcut('local')
    actions.assistShortcut('global')
    vi.setSystemTime(101_000)
    actions.assistShortcut('global')
    vi.useRealTimers()
    await flush()
    expect(runs()).toHaveLength(2)
  })

  it('clear chat clears local cards after main accepts', async () => {
    useLive.getState().upsertCard(failedCard({ id: 'keep', status: 'done', error: null }))
    await actions.clearChat()
    expect(calls.map((c) => c.channel)).toContain('ai:clear')
    expect(useLive.getState().cards).toEqual([])
  })

  it('Hide collapses the panel, or hides the widget when configured', async () => {
    actions.hideFromPill()
    await flush()
    expect(useUi.getState().expanded).toBe(false)
    expect(calls.at(-1)).toEqual({ channel: 'overlay:setExpanded', payload: { expanded: false } })
    const s = useSettings.getState().settings
    useSettings.setState({ settings: { ...s, general: { ...s.general, hideHidesWidget: true } } })
    actions.hideFromPill()
    await flush()
    expect(calls.at(-1)).toEqual({ channel: 'overlay:setVisible', payload: { visible: false } })
  })

  it('setActiveMode is optimistic and reverts when main refuses', async () => {
    const before = useSettings.getState().settings.activeModeId
    failures.set('modes:setActive', { code: 'not_found', message: 'nope' })
    actions.setActiveMode('builtin-sales')
    expect(useSettings.getState().settings.activeModeId).toBe('builtin-sales')
    await flush()
    await flush()
    expect(useSettings.getState().settings.activeModeId).toBe(before)
  })
})

describe('createCapture', () => {
  it('returns the real audio CaptureController, idle until a session starts', () => {
    const capture = createCapture()
    expect(capture).toBeInstanceOf(CaptureController)
    expect(capture.running).toBe(false)
  })
})

function liveCard(patch: Partial<AiCard> & Pick<AiCard, 'id' | 'kind'>): AiCard {
  return failedCard({ status: 'streaming', error: null, sessionId: 's1', ...patch })
}

function resetLive(status: LiveSessionState['status'] = 'live', sessionId: string | null = 's1') {
  useLive.setState({ sessionId: null, lines: [], cards: [] })
  useLive.getState().setState({ ...IDLE_STATE, status, sessionId })
}

describe('answers arriving from main (global shortcuts run in main)', () => {
  it('a manual answer opens the collapsed panel on Insights', () => {
    resetLive()
    useUi.setState({ expanded: false, tab: 'transcript' })
    actions.receiveLiveCard(liveCard({ id: 'say-1', kind: 'say' }))
    expect(useLive.getState().cards.map((c) => c.id)).toEqual(['say-1'])
    expect(useUi.getState().expanded).toBe(true)
    expect(useUi.getState().tab).toBe('insights')
    expect(calls).toContainEqual({ channel: 'overlay:setExpanded', payload: { expanded: true } })
  })

  it('auto-suggestions never pop the panel open; they show as unseen on the pill', () => {
    resetLive()
    useUi.setState({ expanded: false, tab: 'insights' })
    actions.receiveLiveCard(liveCard({ id: 'auto-1', kind: 'auto' }))
    actions.receiveLiveCard(liveCard({ id: 'auto-1', kind: 'auto', text: 'more' }))
    expect(useUi.getState().expanded).toBe(false)
    expect(useUi.getState().unseen).toBe(1)
    expect(calls).toEqual([])
    // Opening the panel on Insights shows them.
    useUi.getState().setExpanded(true)
    expect(useUi.getState().unseen).toBe(0)
  })

  it('updates to a known card, and cards of another session, change nothing', () => {
    resetLive()
    actions.receiveLiveCard(liveCard({ id: 'recap-1', kind: 'recap' }))
    useUi.setState({ expanded: false })
    calls.length = 0
    actions.receiveLiveCard(liveCard({ id: 'recap-1', kind: 'recap', status: 'done' }))
    actions.receiveLiveCard(liveCard({ id: 'other', kind: 'say', sessionId: 's2' }))
    expect(useUi.getState().expanded).toBe(false)
    expect(useLive.getState().cards.map((c) => c.id)).toEqual(['recap-1'])
    expect(calls).toEqual([])
  })
})

describe('typed questions keep the draft when they cannot be sent', () => {
  it('a question over the 4,000 character limit is refused with a notice; the draft stays', async () => {
    const long = `${'word '.repeat(1000)}summarize this`
    useUi.getState().setDraft(long)
    await actions.submitDraft()
    await actions.sendDraft()
    expect(runs()).toEqual([])
    expect(useUi.getState().draft).toBe(long)
    expect(useUi.getState().notice?.message).toBe(
      'Your question is too long (5,014 characters). Shorten it to 4,000 or fewer.',
    )
  })

  it('a question main refuses comes back into the input', async () => {
    failures.set('ai:run', { code: 'invalid_payload', message: 'Invalid payload for ai:run' })
    useUi.getState().setDraft('Summarize this email')
    const sending = actions.sendDraft()
    expect(useUi.getState().draft).toBe('') // clears at once
    await sending
    expect(useUi.getState().draft).toBe('Summarize this email')
    expect(useUi.getState().notice).not.toBeNull()
  })

  it('a restored draft never overwrites what the user typed meanwhile', async () => {
    failures.set('ai:run', { code: 'server', message: 'down' })
    useUi.getState().setDraft('first')
    const sending = actions.sendDraft()
    useUi.getState().setDraft('second')
    await sending
    expect(useUi.getState().draft).toBe('second')
  })

  it('exactly 4,000 characters is sent', async () => {
    const q = 'q'.repeat(actions.MAX_QUESTION_CHARS)
    useUi.getState().setDraft(q)
    await actions.submitDraft()
    expect(runs()).toEqual([{ kind: 'ask', question: q, includeScreen: false, tier: 'smart' }])
    expect(useUi.getState().draft).toBe('')
  })
})

describe('meetings deleted in History disappear from the overlay', () => {
  function seed(status: LiveSessionState['status']) {
    resetLive(status, status === 'idle' ? null : 's1')
    useLive.getState().mergeTranscript('s1', [
      {
        id: 'l1',
        sessionId: 's1',
        channel: 'them',
        startMs: 0,
        endMs: 1,
        text: 'secret',
        isFinal: true,
      },
    ])
    useLive.getState().upsertCard(liveCard({ id: 'c1', kind: 'say', status: 'done' }))
  }

  it('Delete all / delete this meeting drops its transcript and answers', async () => {
    seed('idle')
    responses.set('sessions:get', { id: 's1', title: 'Renamed' })
    await actions.forgetIfDeleted('s1') // a rename also says "changed"
    expect(useLive.getState().lines).toHaveLength(1)
    await actions.forgetIfDeleted('another-session')
    expect(calls.filter((c) => c.channel === 'sessions:get')).toHaveLength(1)

    responses.set('sessions:get', null)
    await actions.forgetIfDeleted(null)
    expect(calls.at(-1)).toEqual({ channel: 'sessions:get', payload: { id: 's1' } })
    expect(useLive.getState()).toMatchObject({ sessionId: null, lines: [], cards: [] })
  })

  it('never drops a session that is still running', async () => {
    seed('live')
    responses.set('sessions:get', null)
    await actions.forgetIfDeleted('s1')
    expect(useLive.getState().lines).toHaveLength(1)
    expect(useLive.getState().cards).toHaveLength(1)
  })
})

function fakeCapture() {
  return {
    running: true,
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    update: vi.fn(),
    setMicDevice: vi.fn(async () => undefined),
    restartChannel: vi.fn(async () => undefined),
    subscribe: vi.fn(() => () => undefined),
  }
}

describe('audio settings changed during a call reach the running capture', () => {
  it('VAD changes update capture; a new microphone switches it; other changes do nothing', async () => {
    const capture = fakeCapture()
    const stop = watchCaptureSettings(capture)
    const s = useSettings.getState().settings
    useSettings.setState({ settings: { ...s, general: { ...s.general, theme: 'light' } } })
    await flush()
    expect(capture.update).not.toHaveBeenCalled()
    expect(capture.setMicDevice).not.toHaveBeenCalled()

    useSettings.setState({
      settings: { ...s, advanced: { ...s.advanced, vadSensitivity: 0.9, maxSegmentSec: 20 } },
    })
    await flush()
    expect(capture.update).toHaveBeenCalledWith({ sensitivity: 0.9, maxSegmentSec: 20 })

    const now = useSettings.getState().settings
    useSettings.setState({ settings: { ...now, audio: { ...now.audio, micDeviceId: 'usb' } } })
    await flush()
    expect(capture.setMicDevice).toHaveBeenCalledWith('usb')
    expect(capture.update).toHaveBeenCalledTimes(1)

    stop()
    useSettings.setState({ settings: { ...now, audio: { ...now.audio, micDeviceId: 'x' } } })
    await flush()
    expect(capture.setMicDevice).toHaveBeenCalledTimes(1)
  })

  it('Retry re-opens the failed channel', async () => {
    const capture = fakeCapture()
    retryCapture('me', capture)
    await flush()
    expect(capture.restartChannel).toHaveBeenCalledWith('me')
  })
})
