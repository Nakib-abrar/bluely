import { describe, expect, it, vi } from 'vitest'

const handlers = vi.hoisted(() => new Map<string, (req: unknown) => unknown>())
vi.mock('@main/ipc/registry', () => ({
  handle: (channel: string, fn: (req: unknown) => unknown) => {
    handlers.set(channel, fn)
  },
}))

import type { CoreContext } from '@main/context'
import { registerLiveHandlers } from '@main/live/handlers'
import type { AiService } from '@main/live/aiService'
import type { NoticeCenter } from '@main/live/notices'
import type { SessionManager } from '@main/live/sessionManager'

function setup() {
  handlers.clear()
  const stopped = Promise.resolve()
  const session = {
    stop: vi.fn(() => stopped),
    setAutoSuggest: vi.fn(),
    setChannelStatus: vi.fn(),
    regenerate: vi.fn(),
  }
  const settings = { update: vi.fn() }
  const ctx = { settings } as unknown as CoreContext
  registerLiveHandlers(ctx, {
    session: session as unknown as SessionManager,
    ai: {} as AiService,
    notices: {} as NoticeCenter,
  })
  const call = (channel: string, req?: unknown) => handlers.get(channel)?.(req)
  return { session, settings, call, stopped }
}

describe('live IPC handlers', () => {
  it("'session:setAutoSuggest' is a per-call override, not a settings write (OV-09)", () => {
    const h = setup()
    h.call('session:setAutoSuggest', { enabled: true })
    expect(h.session.setAutoSuggest).toHaveBeenCalledWith(true)
    expect(h.settings.update).not.toHaveBeenCalled()
  })

  it("'audio:channelStatus' passes the error code through (OV-11)", () => {
    const h = setup()
    h.call('audio:channelStatus', {
      sessionId: 's1',
      channel: 'me',
      state: 'error',
      error: 'Not allowed',
      code: 'mic_denied',
    })
    expect(h.session.setChannelStatus).toHaveBeenCalledWith(
      's1',
      'me',
      'error',
      'Not allowed',
      'mic_denied',
    )
    h.call('audio:channelStatus', {
      sessionId: 's1',
      channel: 'them',
      state: 'listening',
      error: null,
    })
    expect(h.session.setChannelStatus).toHaveBeenLastCalledWith(
      's1',
      'them',
      'listening',
      null,
      null,
    )
  })

  it("'sessions:regenerate' passes the requested parts", () => {
    const h = setup()
    h.call('sessions:regenerate', { id: 's1', parts: ['notes', 'email'] })
    expect(h.session.regenerate).toHaveBeenCalledWith('s1', ['notes', 'email'])
    h.call('sessions:regenerate', { id: 's2' })
    expect(h.session.regenerate).toHaveBeenLastCalledWith('s2', undefined)
  })

  it("'session:stop' resolves when the call has ended", () => {
    const h = setup()
    expect(h.call('session:stop')).toBe(h.stopped)
  })
})
