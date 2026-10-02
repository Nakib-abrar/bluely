import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiCard } from '@shared/types'

interface Call {
  channel: string
  payload: unknown
}

const calls: Call[] = []
/** Channels that should fail, with the error envelope main would send. */
const failures = new Map<string, { code: string; message: string; ai?: unknown }>()

vi.stubGlobal('window', {
  bluely: {
    invoke: async (channel: string, payload: unknown) => {
      calls.push({ channel, payload })
      const error = failures.get(channel)
      if (error) return { ok: false, error }
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
const { useLive } = await import('../../../src/renderer/overlay/stores/liveStore')
const { useSettings } = await import('../../../src/renderer/stores/settings')
const { createCapture } = await import('../../../src/renderer/overlay/capture')

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
  useUi.setState({
    expanded: true,
    tab: 'insights',
    draft: '',
    screenForAssist: true,
    screenForQuestions: false,
    notice: null,
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

describe('placeholder capture', () => {
  it('tracks running and completes the stop handshake with audio:stopped', async () => {
    const capture = createCapture()
    expect(capture.running).toBe(false)
    await capture.start({ sessionId: 's9', micDeviceId: null, sensitivity: 0.5, maxSegmentSec: 12 })
    expect(capture.running).toBe(true)
    const unsub = capture.subscribe(() => undefined)
    unsub()
    await capture.stop()
    expect(capture.running).toBe(false)
    expect(calls).toContainEqual({ channel: 'audio:stopped', payload: { sessionId: 's9' } })
    calls.length = 0
    await capture.stop()
    expect(calls).toEqual([])
  })
})
