import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LiveSessionState, TranscriptLine } from '@shared/types'
import { AiService } from '@main/live/aiService'
import { PostCallRunner } from '@main/live/postCallRunner'
import { SessionManager } from '@main/live/sessionManager'
import { createHarness, segment } from './harness'

function setup() {
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
  return { ...h, ai, postCall, session, lastState }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('SessionManager', () => {
  it('starts a session: DB row, overlay shown, consent reminder, then live on first listening channel', async () => {
    const h = setup()
    const { sessionId } = await h.session.start()
    expect(h.history.sessions.get(sessionId)?.status).toBe('active')
    expect(h.overlay.show).toHaveBeenCalled()
    expect(h.lastState()).toMatchObject({
      status: 'starting',
      sessionId,
      showConsentReminder: true,
    })
    h.session.setChannelStatus(sessionId, 'me', 'listening', null)
    expect(h.lastState().status).toBe('live')
    h.session.dismissConsent()
    expect(h.lastState().showConsentReminder).toBe(false)
  })

  it('turns transcribed segments into persisted, broadcast transcript lines', async () => {
    const h = setup()
    const { sessionId } = await h.session.start()
    const startedAt = h.lastState().startedAt as number
    expect(
      h.session.acceptSegment(segment(sessionId, 'them', startedAt + 1000, startedAt + 3000)),
    ).toBe(true)
    const queue = h.queues[0]!
    queue.deliver(queue.jobs[0]!, 'What does the enterprise plan cost?')
    const line = h.eventsOf('transcript:line')[0] as TranscriptLine
    expect(line).toMatchObject({ channel: 'them', startMs: 1000, endMs: 3000, isFinal: true })
    expect(h.history.transcript.listBySession(sessionId).map((l) => l.text)).toEqual([
      'What does the enterprise plan cost?',
    ])
    expect(h.session.acceptSegment(segment('other-session', 'me', 0, 1))).toBe(false)
  })

  it('drops a Me line that echoes a Them line and shows the headphones tip once', async () => {
    const h = setup()
    const { sessionId } = await h.session.start()
    const t0 = h.lastState().startedAt as number
    h.session.acceptSegment(segment(sessionId, 'them', t0 + 1000, t0 + 4000))
    h.session.acceptSegment(segment(sessionId, 'me', t0 + 1100, t0 + 4100))
    const q = h.queues[0]!
    q.deliver(q.jobs[0]!, 'We currently track everything in spreadsheets every week')
    q.deliver(q.jobs[1]!, 'we currently track everything in spreadsheets every week')
    expect((h.eventsOf('transcript:line') as TranscriptLine[]).map((l) => l.channel)).toEqual([
      'them',
    ])
    expect(h.lastState().warnings).toContain('use_headphones')
    expect(h.settings.get().general.headphonesTipShown).toBe(true)
  })

  it('auto-suggests after a Them question (debounced) with the Auto label', async () => {
    const h = setup()
    const { sessionId } = await h.session.start()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const t0 = h.lastState().startedAt as number
    h.session.acceptSegment(segment(sessionId, 'them', t0 + 1000, t0 + 3000))
    const q = h.queues[0]!
    q.deliver(q.jobs[0]!, 'How long does onboarding usually take?')
    expect(h.eventsOf('ai:card')).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(800)
    vi.useRealTimers()
    await vi.waitFor(() => expect(h.eventsOf('ai:done')).toHaveLength(1))
    const card = h.eventsOf('ai:card')[0] as { kind: string; label: string }
    expect(card).toMatchObject({ kind: 'auto', label: 'Auto · they asked a question' })
  })

  it('stop → waits for audio, ends the session, runs post-call and returns to idle', async () => {
    const h = setup()
    h.llm.reply = (req) => {
      const text = JSON.stringify(req.messages)
      if (text.includes('action item'))
        return JSON.stringify({ items: [{ text: 'Send pricing', owner: 'Me', due: null }] })
      if (text.toLowerCase().includes('email'))
        return JSON.stringify({ subject: 'Next steps', body: 'Thanks!' })
      return JSON.stringify({
        title: 'Pricing call',
        summary: 'We discussed pricing.',
        keyPoints: ['Per seat'],
        decisions: [],
      })
    }
    const { sessionId } = await h.session.start()
    const t0 = h.lastState().startedAt as number
    h.session.acceptSegment(segment(sessionId, 'them', t0 + 1000, t0 + 3000))
    h.queues[0]!.deliver(
      h.queues[0]!.jobs[0]!,
      'Can you send me the pricing sheet after this call please',
    )
    const stopping = h.session.stop()
    expect(h.lastState().status).toBe('stopping')
    h.session.audioStopped(sessionId)
    await stopping
    const detail = h.history.sessions.getDetail(sessionId)
    expect(detail?.status).toBe('done')
    expect(detail?.title).toBe('Pricing call')
    expect(detail?.actionItems.map((a) => a.text)).toEqual(['Send pricing'])
    expect(detail?.email?.subject).toBe('Next steps')
    expect(h.lastState().status).toBe('idle')
    expect(h.overlay.hide).toHaveBeenCalled()
    expect(h.ctx.showMainWindow).toHaveBeenCalledWith({ name: 'session', sessionId, tab: 'notes' })
  })

  it('shutdown during a call keeps the transcript and marks the session recovered', async () => {
    const h = setup()
    const { sessionId } = await h.session.start()
    await h.session.shutdown()
    expect(h.history.sessions.get(sessionId)?.status).toBe('recovered')
  })
})
