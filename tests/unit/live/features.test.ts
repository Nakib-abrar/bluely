import { describe, expect, it, vi } from 'vitest'
import type { LiveSessionState, Notice, OverlayCommand } from '@shared/types'

// features.ts pulls in the updater; keep electron-updater out of unit tests.
vi.mock('electron-updater', () => ({ autoUpdater: {} }))

import type { CoreContext } from '@main/context'
import { onSessionsChanged, sessionBusy, shortcutActions, watchCapture } from '@main/features'
import { AiService } from '@main/live/aiService'
import { NoticeCenter } from '@main/live/notices'
import { PostCallRunner } from '@main/live/postCallRunner'
import { SessionManager } from '@main/live/sessionManager'
import type { ChatRequest, ChatResult } from '@main/providers/llm/LLMProvider'
import { createHarness, segment } from './harness'

/** A SessionManager on the shared harness, with post-call (Notes model) requests gated. */
function sessionHarness() {
  const h = createHarness()
  const ai = new AiService(h.ctx, h.models, h.modes, h.history)
  const postCall = new PostCallRunner(h.ctx, h.models, h.history)
  const session = new SessionManager(h.ctx, {
    models: h.models,
    stt: h.stt,
    history: h.history,
    modes: h.modes,
    ai,
    postCall,
  })
  const lastState = () => h.eventsOf('session:state').at(-1) as LiveSessionState
  const notices = () => h.eventsOf('app:notices').at(-1) as Notice[] | undefined
  const gatePostCall = () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const complete = h.llm.complete.bind(h.llm)
    h.llm.complete = async (req: ChatRequest): Promise<ChatResult> => {
      await gate
      return complete(req)
    }
    return () => release()
  }
  return { h, ai, session, lastState, notices, gatePostCall }
}

describe('"Restart to update" is refused while work would be cut short (mainui F14)', () => {
  it('during a call, and while the notes of the call that ended are written', async () => {
    const { h, session, lastState, gatePostCall } = sessionHarness()
    expect(sessionBusy(session)).toBeNull()
    const release = gatePostCall()
    const { sessionId } = await session.start()
    session.setChannelStatus(sessionId, 'them', 'listening', null)
    expect(sessionBusy(session)).toBe('live')
    const t0 = lastState().startedAt as number
    session.acceptSegment(segment(sessionId, 'them', t0, t0 + 1000))
    h.queues[0]!.deliver(h.queues[0]!.jobs[0]!, 'Let us send the pricing sheet tomorrow.')
    await session.stop()
    expect(lastState().status).toBe('processing')
    expect(sessionBusy(session)).toBe('notes')
    release()
    await session.whenPostCallIdle()
    expect(sessionBusy(session)).toBeNull()
  })
})

describe('an overlay that keeps crashing is reported outside the overlay (live F6/OV-04)', () => {
  function setup() {
    const s = sessionHarness()
    const center = new NoticeCenter(s.h.ctx, s.h.history)
    watchCapture(s.h.ctx, { session: s.session, notices: center })
    const banner = () => s.notices()?.find((n) => n.id === 'capture-failed')
    return { ...s, banner }
  }

  it('a reloaded renderer only marks the channels; one that stays gone raises a banner', async () => {
    const { h, session, lastState, banner } = setup()
    const { sessionId } = await session.start()
    session.setChannelStatus(sessionId, 'me', 'listening', null)
    session.setChannelStatus(sessionId, 'them', 'listening', null)

    h.overlay.rendererGone(true)
    expect(lastState().audio.me).toMatchObject({
      state: 'error',
      error: 'Audio capture stopped unexpectedly. Restarting it…',
    })
    expect(session.captureFailed()).toBe(false)
    expect(banner()).toBeUndefined()

    h.overlay.rendererGone(false)
    expect(session.captureFailed()).toBe(true)
    expect(lastState()).toMatchObject({ status: 'live', sessionId })
    expect(lastState().audio.them.error).toBe(
      'Audio capture keeps crashing; nothing is being transcribed.',
    )
    expect(banner()).toMatchObject({
      kind: 'error',
      title: 'Bluely is not capturing this call',
      dismissible: false,
    })

    // Shown again: the new overlay renderer restarts capture and the banner goes away.
    session.setChannelStatus(sessionId, 'me', 'listening', null)
    expect(session.captureFailed()).toBe(false)
    expect(banner()).toBeUndefined()
  })

  it('the banner goes away when the call is stopped', async () => {
    const { h, session, banner } = setup()
    const { sessionId } = await session.start()
    session.setChannelStatus(sessionId, 'me', 'listening', null)
    h.overlay.rendererGone(false)
    expect(banner()).toBeDefined()
    await session.stop()
    expect(session.captureFailed()).toBe(false)
    expect(banner()).toBeUndefined()
    await session.whenPostCallIdle()
  })

  it('a crash while no call runs raises nothing', () => {
    const { h, session, banner } = setup()
    h.overlay.rendererGone(false)
    expect(session.captureFailed()).toBe(false)
    expect(banner()).toBeUndefined()
  })
})

describe('global action shortcuts (OV-02)', () => {
  function overlayCtx(visible: boolean) {
    const sent: { kind: string; event: string; payload: unknown }[] = []
    const overlay = {
      isVisible: () => visible,
      show: vi.fn(),
      window: { webContents: { isLoading: () => false } },
    }
    const ctx = {
      overlay,
      events: {
        sendTo: (kind: string, event: string, payload: unknown) =>
          sent.push({ kind, event, payload }),
      },
    } as unknown as CoreContext
    return { ctx, overlay, sent }
  }

  it('run through the overlay so the panel expands and shows the answer', () => {
    const { ctx, overlay, sent } = overlayCtx(false)
    const actions = shortcutActions(ctx, { session: { stop: vi.fn() } })
    actions.runAction('say')
    expect(overlay.show).toHaveBeenCalledWith(false)
    const command: OverlayCommand = { type: 'action', action: 'say' }
    expect(sent).toEqual([{ kind: 'overlay', event: 'overlay:command', payload: command }])
  })

  it('do not re-show a visible overlay', () => {
    const { ctx, overlay, sent } = overlayCtx(true)
    shortcutActions(ctx, { session: { stop: vi.fn() } }).runAction('recap')
    expect(overlay.show).not.toHaveBeenCalled()
    expect(sent.map((s) => s.payload)).toEqual([{ type: 'action', action: 'recap' }])
  })
})

describe('deleting data clears what the overlay still shows (SEC-4, mainui F6)', () => {
  async function endedCall() {
    const h = createHarness()
    const ai = new AiService(h.ctx, h.models, h.modes, h.history)
    const postCall = new PostCallRunner(h.ctx, h.models, h.history)
    const session = new SessionManager(h.ctx, {
      models: h.models,
      stt: h.stt,
      history: h.history,
      modes: h.modes,
      ai,
      postCall,
    })
    const { sessionId } = await session.start()
    session.setChannelStatus(sessionId, 'them', 'listening', null)
    const t0 = (h.eventsOf('session:state').at(-1) as LiveSessionState).startedAt as number
    session.acceptSegment(segment(sessionId, 'them', t0, t0 + 1000))
    const q = h.queues[0]!
    q.deliver(q.jobs[0]!, 'Our budget is confidential.')
    h.llm.reply = () => 'An answer about the confidential budget.'
    await ai.startLive({ kind: 'recap' }).finished
    await session.stop()
    await session.whenPostCallIdle()
    expect(ai.getCards('live')).toHaveLength(1)
    const deps = { session, ai, history: h.history, modes: h.modes }
    return { h, ai, session, sessionId, deps }
  }

  it('deleting the last call clears its overlay answers', async () => {
    const { h, ai, session, sessionId, deps } = await endedCall()
    h.history.sessions.delete(sessionId)
    onSessionsChanged(h.ctx, deps, sessionId)
    expect(ai.getCards('live')).toEqual([])
    expect(h.eventsOf('ai:cleared')).toContainEqual({ scope: 'live' })
    expect(session.lastSessionId()).toBeNull()
  })

  it('"Delete all" clears them and re-broadcasts Modes and their files', async () => {
    const { h, ai, sessionId, deps } = await endedCall()
    h.history.sessions.delete(sessionId)
    const before = h.emitted.length
    onSessionsChanged(h.ctx, deps, null)
    expect(ai.getCards('live')).toEqual([])
    const events = h.emitted.slice(before)
    const modes = events.find((e) => e.event === 'modes:changed')?.payload as { id: string }[]
    expect(modes.map((m) => m.id)).toContain('builtin-general')
    const knowledge = events.filter((e) => e.event === 'knowledge:changed')
    expect(knowledge).toHaveLength(modes.length)
  })

  it('keeps them when another session changes, or retention keeps the last call', async () => {
    const { h, ai, sessionId, deps } = await endedCall()
    onSessionsChanged(h.ctx, deps, 'some-other-session')
    onSessionsChanged(h.ctx, deps, sessionId) // renamed, not deleted
    onSessionsChanged(h.ctx, deps, null) // retention removed older sessions
    expect(ai.getCards('live')).toHaveLength(1)
  })
})
