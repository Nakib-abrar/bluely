import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Channel } from '@shared/types'
import {
  CaptureController,
  failureWarning,
  SNAPSHOT_INTERVAL_MS,
  type CapturePipeline,
  type CaptureSink,
  type CaptureSnapshot,
} from '@renderer/audio/captureController'
import type { ChannelPipelineOptions } from '@renderer/audio/channelPipeline'
import { AudioSourceError, type AudioSource } from '@renderer/audio/sources'
import { decodeWav16 } from '@renderer/audio/wav'

class FakePipeline implements CapturePipeline {
  startImpl: () => Promise<void> = async () => {
    this.opts.onStatus('starting', null)
    this.opts.onStatus('listening', null)
  }
  stopImpl: (flush: boolean) => Promise<void> = async () => {
    this.opts.onStatus('off', null)
  }
  start = vi.fn(() => this.startImpl())
  stop = vi.fn((o?: { flush?: boolean }) => this.stopImpl(o?.flush ?? true))
  setSensitivity = vi.fn()
  setMaxSegmentMs = vi.fn()
  constructor(readonly opts: ChannelPipelineOptions) {}
  fail(error: AudioSourceError) {
    this.startImpl = async () => {
      this.opts.onStatus('starting', null)
      this.opts.onStatus('error', error)
      throw error
    }
  }
}

function recordingSink() {
  const calls: string[] = []
  const logs: string[] = []
  const sink = {
    segment: vi.fn(async (req: Parameters<CaptureSink['segment']>[0]) => {
      calls.push(`segment:${req.channel}`)
      return { accepted: true }
    }),
    channelStatus: vi.fn(async (req: Parameters<CaptureSink['channelStatus']>[0]) => {
      calls.push(`status:${req.channel}:${req.state}`)
    }),
    warning: vi.fn(async (req: Parameters<CaptureSink['warning']>[0]) => {
      calls.push(`warning:${req.code}:${req.active}`)
    }),
    stopped: vi.fn(async (req: Parameters<CaptureSink['stopped']>[0]) => {
      calls.push(`stopped:${req.sessionId}`)
    }),
    log: vi.fn((level: string, message: string) => {
      logs.push(`${level}:${message}`)
    }),
  } satisfies CaptureSink
  return { sink, calls, logs }
}

function setup(
  configure: (p: FakePipeline, channel: Channel, n: number) => void = () => undefined,
  extra: { micFallbackToDefault?: boolean } = {},
) {
  const { sink, calls, logs } = recordingSink()
  const pipelines: FakePipeline[] = []
  const sources: { channel: Channel; deviceId: string | null }[] = []
  const deviceListeners = new Set<() => void>()
  let now = 1_000_000
  const controller = new CaptureController({
    sink,
    now: () => now,
    watchDevices: (onChange) => {
      deviceListeners.add(onChange)
      return () => deviceListeners.delete(onChange)
    },
    createSource: (channel, deviceId) => {
      sources.push({ channel, deviceId })
      return { kind: channel === 'me' ? 'mic' : 'loopback' } as unknown as AudioSource
    },
    createPipeline: (opts) => {
      const p = new FakePipeline(opts)
      configure(p, opts.channel, pipelines.filter((x) => x.opts.channel === opts.channel).length)
      pipelines.push(p)
      return p
    },
    stopTimeoutMs: 2000,
    recoveryDelayMs: 10,
    ...extra,
  })
  const pipe = (channel: Channel, n = 0) =>
    pipelines.filter((p) => p.opts.channel === channel)[n] as FakePipeline
  return {
    controller,
    sink,
    calls,
    logs,
    pipelines,
    sources,
    pipe,
    advance: (ms: number) => {
      now += ms
    },
    now: () => now,
    /** Fires navigator.mediaDevices 'devicechange'. */
    changeDevices: () => {
      for (const listener of [...deviceListeners]) listener()
    },
    deviceListeners,
  }
}

const opts = (sessionId = 's1', micDeviceId: string | null = null) => ({
  sessionId,
  micDeviceId,
  sensitivity: 0.5,
  maxSegmentSec: 12,
})

/** start() first clears every capture warning a previous renderer may have left in main. */
const START_CLEARS = [
  'warning:mic_not_found:false',
  'warning:mic_denied:false',
  'warning:loopback_unavailable:false',
  'warning:no_system_audio:false',
  'warning:mic_muted:false',
]

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

afterEach(() => {
  vi.useRealTimers()
})

describe('CaptureController', () => {
  it('starts both channels and reports their status for the session', async () => {
    const t = setup()
    expect(t.controller.running).toBe(false)
    await t.controller.start(opts('s1', 'usb-mic'))
    expect(t.controller.running).toBe(true)
    expect(t.sources).toEqual([
      { channel: 'me', deviceId: 'usb-mic' },
      { channel: 'them', deviceId: null },
    ])
    expect(t.pipe('me').opts.maxSegmentMs).toBe(12_000)
    expect(t.pipe('me').opts.sensitivity).toBe(0.5)
    expect(t.sink.channelStatus).toHaveBeenCalledWith({
      sessionId: 's1',
      channel: 'them',
      state: 'listening',
      error: null,
      code: null,
    })
    expect(t.calls).toEqual([
      ...START_CLEARS,
      'status:me:starting',
      'status:me:listening',
      'status:them:starting',
      'status:them:listening',
    ])
  })

  it('clamps options to the settings ranges', async () => {
    const t = setup()
    await t.controller.start({ sessionId: 's', micDeviceId: '', sensitivity: 9, maxSegmentSec: 99 })
    expect(t.pipe('me').opts.sensitivity).toBe(1)
    expect(t.pipe('me').opts.maxSegmentMs).toBe(30_000)
    expect(t.sources[0]).toEqual({ channel: 'me', deviceId: null })
    await expect(t.controller.start({ ...opts(), sessionId: '' })).rejects.toThrow(/sessionId/)
  })

  it('keeps the other channel running when one fails', async () => {
    const t = setup((p, channel) => {
      if (channel === 'them') p.fail(new AudioSourceError('loopback_unavailable', 'no loopback'))
    })
    await t.controller.start(opts())
    expect(t.calls).toContain('status:me:listening')
    expect(t.calls).toContain('status:them:error')
    expect(t.calls).toContain('warning:loopback_unavailable:true')
    expect(t.sink.channelStatus).toHaveBeenCalledWith({
      sessionId: 's1',
      channel: 'them',
      state: 'error',
      error: 'no loopback',
      code: 'loopback_unavailable',
    })
    expect(t.controller.running).toBe(true)
  })

  it('reports a denied mic as mic_denied (not "not found") and sends the error code', async () => {
    const t = setup((p, channel) => {
      if (channel === 'me') p.fail(new AudioSourceError('mic_denied', 'denied by Windows'))
    })
    await t.controller.start(opts())
    expect(t.calls).toContain('status:me:error')
    expect(t.calls).toContain('warning:mic_denied:true')
    expect(t.calls).not.toContain('warning:mic_not_found:true')
    expect(t.sink.channelStatus).toHaveBeenCalledWith({
      sessionId: 's1',
      channel: 'me',
      state: 'error',
      error: 'denied by Windows',
      code: 'mic_denied',
    })
    // The warning goes first, so the overlay never shows a generic failure in between.
    expect(t.calls.indexOf('warning:mic_denied:true')).toBeLessThan(
      t.calls.indexOf('status:me:error'),
    )
  })

  it('raises no device warning for failures that are not about a device (VAD, busy)', async () => {
    const t = setup((p) => p.fail(new AudioSourceError('unknown', 'Voice detection failed')))
    await t.controller.start(opts())
    expect(t.calls).toContain('status:me:error')
    expect(t.calls).toContain('status:them:error')
    expect(t.calls.filter((c) => c.endsWith(':true'))).toEqual([])
    expect(t.sink.channelStatus).toHaveBeenCalledWith({
      sessionId: 's1',
      channel: 'them',
      state: 'error',
      error: 'Voice detection failed',
      code: 'unknown',
    })
  })

  it('swaps the failure warning when the reason changes, and clears it once listening', async () => {
    const t = setup((p, channel) => {
      if (channel === 'me') p.fail(new AudioSourceError('mic_denied', 'denied'))
    })
    await t.controller.start(opts())
    const me = t.pipe('me').opts
    me.onStatus('error', new AudioSourceError('mic_not_found', 'unplugged'))
    expect(t.calls.slice(-3)).toEqual([
      'warning:mic_not_found:true',
      'warning:mic_denied:false',
      'status:me:error',
    ])
    me.onStatus('listening', null)
    expect(t.calls.slice(-2)).toEqual(['status:me:listening', 'warning:mic_not_found:false'])
  })

  it('maps error codes to warnings', () => {
    expect(failureWarning('me', 'mic_not_found')).toBe('mic_not_found')
    expect(failureWarning('me', 'mic_denied')).toBe('mic_denied')
    expect(failureWarning('me', 'unknown')).toBeNull()
    expect(failureWarning('me', undefined)).toBeNull()
    expect(failureWarning('them', 'loopback_unavailable')).toBe('loopback_unavailable')
    expect(failureWarning('them', 'unknown')).toBeNull()
  })

  it('a new controller clears capture warnings a previous renderer left in main', async () => {
    // e.g. "mic muted" was raised by the overlay before it was closed and re-created mid-call.
    const t = setup()
    await t.controller.start(opts('s1'))
    expect(t.calls.slice(0, START_CLEARS.length)).toEqual(START_CLEARS)
    expect(t.sink.warning).toHaveBeenCalledWith({
      sessionId: 's1',
      code: 'mic_muted',
      active: false,
    })
  })

  it('falls back to the default mic when the saved one is missing, without flashing an error', async () => {
    const t = setup((p, channel, n) => {
      if (channel === 'me' && n === 0) p.fail(new AudioSourceError('mic_not_found', 'gone'))
    })
    await t.controller.start(opts('s1', 'unplugged-headset'))
    expect(t.sources.filter((s) => s.channel === 'me')).toEqual([
      { channel: 'me', deviceId: 'unplugged-headset' },
      { channel: 'me', deviceId: null },
    ])
    expect(t.calls.filter((c) => c.startsWith('status:me'))).toEqual([
      'status:me:starting',
      'status:me:starting',
      'status:me:listening',
    ])
    expect(t.calls.some((c) => c.startsWith('warning:') && c.endsWith(':true'))).toBe(false)
    expect(t.logs.some((l) => /default mic/.test(l))).toBe(true)
    expect(t.pipe('me', 0).stop).toHaveBeenCalledWith({ flush: false })
  })

  it('reports the missing mic when fallback is disabled or also fails', async () => {
    const off = setup(
      (p, channel) => {
        if (channel === 'me') p.fail(new AudioSourceError('mic_not_found', 'gone'))
      },
      { micFallbackToDefault: false },
    )
    await off.controller.start(opts('s1', 'x'))
    expect(off.calls).toContain('warning:mic_not_found:true')
    expect(off.sources.filter((s) => s.channel === 'me')).toHaveLength(1)

    const both = setup((p, channel) => {
      if (channel === 'me') p.fail(new AudioSourceError('mic_not_found', 'none at all'))
    })
    await both.controller.start(opts('s1', 'x'))
    expect(both.calls).toContain('status:me:error')
    expect(both.calls).toContain('warning:mic_not_found:true')
  })

  it('reports a mic lost mid-session and re-opens the default mic', async () => {
    const t = setup()
    await t.controller.start(opts('s1', 'usb-headset'))
    const lost = t.pipe('me', 0)
    lost.opts.onStatus('error', new AudioSourceError('mic_not_found', 'disconnected'))
    expect(t.calls.slice(-2)).toEqual(['warning:mic_not_found:true', 'status:me:error'])
    await new Promise((r) => setTimeout(r, 40))
    expect(lost.stop).toHaveBeenCalledWith({ flush: false })
    expect(t.sources.filter((x) => x.channel === 'me').at(-1)).toEqual({
      channel: 'me',
      deviceId: null,
    })
    expect(t.calls).toContain('warning:mic_not_found:false')
    expect(t.calls.filter((c) => c === 'status:me:listening')).toHaveLength(2)
    expect(t.calls).not.toContain('status:me:off') // the replaced pipeline's 'off' is hidden
    await t.controller.stop()
    expect(t.calls.at(-1)).toBe('stopped:s1')
  })

  it('re-opens a loopback that ended mid-session', async () => {
    const t = setup()
    await t.controller.start(opts())
    t.pipe('them').opts.onStatus('error', new AudioSourceError('loopback_unavailable', 'ended'))
    expect(t.calls).toContain('warning:loopback_unavailable:true')
    await new Promise((r) => setTimeout(r, 40))
    expect(t.pipelines.filter((p) => p.opts.channel === 'them')).toHaveLength(2)
    expect(t.calls.at(-1)).toBe('warning:loopback_unavailable:false')
  })

  it('does not retry start-up failures or unknown errors', async () => {
    const t = setup((p, channel) => {
      if (channel === 'them') p.fail(new AudioSourceError('loopback_unavailable', 'no loopback'))
    })
    await t.controller.start(opts())
    t.pipe('me').opts.onStatus('error', new AudioSourceError('unknown', 'VAD broke'))
    await new Promise((r) => setTimeout(r, 40))
    expect(t.pipelines).toHaveLength(2)
  })

  it('gives up re-opening the mic after a few attempts and never after stop()', async () => {
    const t = setup((p, channel, n) => {
      if (channel === 'me' && n > 0) {
        p.startImpl = async () => {
          p.opts.onStatus('starting', null)
          p.opts.onStatus('listening', null)
          // Immediately lost again.
          p.opts.onStatus('error', new AudioSourceError('mic_not_found', 'flaky'))
        }
      }
    })
    await t.controller.start(opts())
    t.pipe('me').opts.onStatus('error', new AudioSourceError('mic_not_found', 'gone'))
    await new Promise((r) => setTimeout(r, 150))
    expect(t.pipelines.filter((p) => p.opts.channel === 'me')).toHaveLength(4) // 1 + 3 retries
    await t.controller.stop()

    const s = setup((p) => p)
    await s.controller.start(opts())
    s.pipe('me').opts.onStatus('error', new AudioSourceError('mic_not_found', 'gone'))
    await s.controller.stop()
    await new Promise((r) => setTimeout(r, 40))
    expect(s.pipelines.filter((p) => p.opts.channel === 'me')).toHaveLength(1)
  })

  it('uploads segments as 16 kHz WAV and stop() awaits them before audio:stopped', async () => {
    const t = setup()
    let resolveUpload: (v: { accepted: boolean }) => void = () => undefined
    t.sink.segment.mockImplementationOnce(async (req) => {
      t.calls.push(`segment:${req.channel}`)
      return new Promise((r) => (resolveUpload = r))
    })
    await t.controller.start(opts())
    const samples = new Float32Array(16_000).fill(0.25)
    t.pipe('me').opts.onSegment({
      channel: 'me',
      startedAt: 1000,
      endedAt: 2000,
      vadEndAt: 2400,
      forced: true,
      samples,
    })
    const req = t.sink.segment.mock.calls[0]?.[0]
    expect(req).toMatchObject({
      sessionId: 's1',
      channel: 'me',
      startedAt: 1000,
      endedAt: 2000,
      vadEndAt: 2400,
      forced: true,
    })
    const decoded = decodeWav16(req?.wav as Uint8Array)
    expect(decoded.sampleRate).toBe(16_000)
    expect(decoded.samples.length).toBe(16_000)

    let stopped = false
    const stopping = t.controller.stop().then(() => (stopped = true))
    await new Promise((r) => setTimeout(r, 20))
    expect(stopped).toBe(false)
    expect(t.sink.stopped).not.toHaveBeenCalled()
    resolveUpload({ accepted: true })
    await stopping
    expect(t.calls.at(-1)).toBe('stopped:s1')
    expect(t.controller.running).toBe(false)
  })

  it('flushes on stop: trailing segments emitted during stop are uploaded first', async () => {
    const t = setup((p) => {
      p.stopImpl = async (flush) => {
        if (flush) {
          p.opts.onSegment({
            channel: p.opts.channel,
            startedAt: 1,
            endedAt: 2,
            vadEndAt: 3,
            forced: false,
            samples: new Float32Array(800),
          })
        }
        p.opts.onStatus('off', null)
      }
    })
    await t.controller.start(opts())
    const started = t.calls.length
    await t.controller.stop()
    expect(t.pipe('me').stop).toHaveBeenCalledWith({ flush: true })
    const order = t.calls.slice(started)
    expect(order).toEqual(
      expect.arrayContaining(['segment:me', 'segment:them', 'status:me:off', 'status:them:off']),
    )
    expect(order.at(-1)).toBe('stopped:s1')
  })

  it('stop() clears active warnings before audio:stopped and is idempotent', async () => {
    const t = setup()
    await t.controller.start(opts())
    t.pipe('me').opts.onMuted?.(true)
    expect(t.calls).toContain('warning:mic_muted:true')
    await t.controller.stop()
    const cleared = t.calls.indexOf('warning:mic_muted:false')
    expect(cleared).toBeGreaterThan(-1)
    expect(cleared).toBeLessThan(t.calls.indexOf('stopped:s1'))
    expect(t.calls.at(-1)).toBe('stopped:s1')
    await t.controller.stop()
    expect(t.sink.stopped).toHaveBeenCalledTimes(1)
    // Late callbacks from the stopped session are ignored.
    t.pipe('me').opts.onMuted?.(true)
    t.pipe('me').opts.onStatus('error', new AudioSourceError('unknown', 'late'))
    expect(t.calls.at(-1)).toBe('stopped:s1')
  })

  it('treats ≥ 5 s of digital silence on the mic as muted (Windows endpoint mute)', async () => {
    const t = setup()
    await t.controller.start(opts())
    const me = t.pipe('me').opts
    for (let i = 0; i < 5; i++) {
      t.advance(1000)
      me.onLevel(0)
    }
    expect(t.calls).not.toContain('warning:mic_muted:true')
    t.advance(1000)
    me.onLevel(0)
    expect(t.calls.at(-1)).toBe('warning:mic_muted:true')
    me.onLevel(0.001) // −60 dBFS room noise: the mic is live again
    expect(t.calls.at(-1)).toBe('warning:mic_muted:false')
    // A muted track keeps the warning on even with signal; unmuting clears it.
    me.onMuted?.(true)
    me.onLevel(0.01)
    expect(t.calls.at(-1)).toBe('warning:mic_muted:true')
    me.onMuted?.(false)
    expect(t.calls.at(-1)).toBe('warning:mic_muted:false')
    // A failed mic is "not found", never "muted".
    me.onMuted?.(true)
    me.onStatus('error', new AudioSourceError('mic_not_found', 'unplugged'))
    expect(t.calls.slice(-3)).toEqual([
      'warning:mic_not_found:true',
      'status:me:error',
      'warning:mic_muted:false',
    ])
  })

  it('raises and clears no_system_audio', async () => {
    const t = setup()
    await t.controller.start(opts())
    const me = t.pipe('me').opts
    const them = t.pipe('them').opts
    me.onSpeaking(true)
    for (let i = 0; i < 21; i++) {
      t.advance(1000)
      me.onLevel(0.1)
      them.onLevel(0.0005) // −66 dBFS
    }
    expect(t.calls).toContain('warning:no_system_audio:true')
    them.onLevel(0.05)
    expect(t.calls.at(-1)).toBe('warning:no_system_audio:false')
  })

  it('does not warn about system audio while nobody talks', async () => {
    const t = setup()
    await t.controller.start(opts())
    for (let i = 0; i < 30; i++) {
      t.advance(1000)
      t.pipe('them').opts.onLevel(0)
    }
    expect(t.calls).not.toContain('warning:no_system_audio:true')
  })

  it('publishes throttled snapshots with peak levels', async () => {
    vi.useFakeTimers()
    const t = setup()
    await t.controller.start(opts())
    const snaps: CaptureSnapshot[] = []
    const unsubscribe = t.controller.subscribe((s) => snaps.push(s))
    expect(snaps).toHaveLength(1) // immediate
    expect(snaps[0]?.me.state).toBe('listening')
    for (let i = 0; i < 30; i++) {
      t.pipe('me').opts.onLevel(i === 10 ? 0.8 : 0.1)
      t.pipe('them').opts.onSpeaking(i % 2 === 0)
      t.advance(5)
    }
    await vi.advanceTimersByTimeAsync(SNAPSHOT_INTERVAL_MS + 5)
    expect(snaps.length).toBeLessThanOrEqual(3)
    const last = snaps.at(-1) as CaptureSnapshot
    expect(last.me.rms).toBeCloseTo(0.8, 9) // peak-hold between snapshots
    expect(last.them.speaking).toBe(false)
    // One second of 31 Hz updates → at most ~15 snapshots.
    const before = snaps.length
    for (let i = 0; i < 31; i++) {
      t.pipe('me').opts.onLevel(0.2)
      t.advance(32)
      await vi.advanceTimersByTimeAsync(32)
    }
    expect(snaps.length - before).toBeLessThanOrEqual(16)
    expect(snaps.length - before).toBeGreaterThanOrEqual(10)
    unsubscribe()
    const count = snaps.length
    t.pipe('me').opts.onLevel(0.3)
    await vi.advanceTimersByTimeAsync(200)
    expect(snaps.length).toBe(count)
  })

  it('restarting for a new session stops the previous one first', async () => {
    const t = setup()
    await t.controller.start(opts('s1'))
    await t.controller.start(opts('s2'))
    expect(t.calls).toContain('stopped:s1')
    expect(t.sink.channelStatus).toHaveBeenLastCalledWith({
      sessionId: 's2',
      channel: 'them',
      state: 'listening',
      error: null,
      code: null,
    })
    expect(t.controller.running).toBe(true)
  })

  it('stop() during start() waits for the start to settle', async () => {
    const t = setup((p) => {
      p.startImpl = async () => {
        p.opts.onStatus('starting', null)
        await new Promise((r) => setTimeout(r, 30))
        p.opts.onStatus('listening', null)
      }
    })
    const starting = t.controller.start(opts())
    await t.controller.stop()
    await starting
    expect(t.calls.at(-1)).toBe('stopped:s1')
    expect(t.controller.running).toBe(false)
  })

  it('update() pushes VAD settings to running pipelines', async () => {
    const t = setup()
    await t.controller.start(opts())
    t.controller.update({ sensitivity: 0.8, maxSegmentSec: 20 })
    expect(t.pipe('them').setSensitivity).toHaveBeenCalledWith(0.8)
    expect(t.pipe('me').setMaxSegmentMs).toHaveBeenCalledWith(20_000)
  })

  it('switches the microphone mid-session: only Me restarts, flushing what it heard', async () => {
    const t = setup()
    await t.controller.start(opts('s1', 'laptop-mic'))
    const before = t.pipe('me', 0)
    await t.controller.setMicDevice('usb-headset')
    expect(before.stop).toHaveBeenCalledWith({ flush: true })
    expect(t.sources.filter((s) => s.channel === 'me')).toEqual([
      { channel: 'me', deviceId: 'laptop-mic' },
      { channel: 'me', deviceId: 'usb-headset' },
    ])
    expect(t.pipelines.filter((p) => p.opts.channel === 'them')).toHaveLength(1)
    expect(t.calls.filter((c) => c === 'status:me:listening')).toHaveLength(2)
    expect(t.calls).not.toContain('status:me:off') // the replaced pipeline's 'off' is hidden
    // The same device again is a no-op.
    await t.controller.setMicDevice('usb-headset')
    expect(t.pipelines.filter((p) => p.opts.channel === 'me')).toHaveLength(2)
    // A later recovery or restart keeps using the new device.
    await t.controller.restartChannel('me')
    expect(t.sources.at(-1)).toEqual({ channel: 'me', deviceId: 'usb-headset' })
    await t.controller.stop()
    expect(t.calls.at(-1)).toBe('stopped:s1')
    // Not running: nothing to switch.
    await t.controller.setMicDevice('other')
    expect(t.pipelines.filter((p) => p.opts.channel === 'me')).toHaveLength(3)
  })

  it('a mic picked in Settings after "No microphone found" clears the warning', async () => {
    const t = setup((p, channel, n) => {
      if (channel === 'me' && n === 0) p.fail(new AudioSourceError('mic_not_found', 'none'))
    })
    await t.controller.start(opts('s1', null))
    expect(t.calls).toContain('warning:mic_not_found:true')
    await t.controller.setMicDevice('usb-headset')
    expect(t.calls.at(-2)).toBe('status:me:listening')
    expect(t.calls.at(-1)).toBe('warning:mic_not_found:false')
  })

  it('re-opens a failed mic when audio devices change (mic plugged in)', async () => {
    const t = setup((p, channel, n) => {
      if (channel === 'me' && n === 0) p.fail(new AudioSourceError('mic_not_found', 'none'))
    })
    await t.controller.start(opts())
    expect(t.deviceListeners.size).toBe(1)
    // Windows fires several events while the device settles: one re-open.
    t.changeDevices()
    t.changeDevices()
    t.changeDevices()
    await wait(40)
    expect(t.pipelines.filter((p) => p.opts.channel === 'me')).toHaveLength(2)
    expect(t.calls.at(-1)).toBe('warning:mic_not_found:false')
    // A working mic is left alone.
    t.changeDevices()
    await wait(40)
    expect(t.pipelines.filter((p) => p.opts.channel === 'me')).toHaveLength(2)
    await t.controller.stop()
    expect(t.deviceListeners.size).toBe(0)
  })

  it('Retry re-opens a denied mic once access is allowed', async () => {
    const t = setup((p, channel, n) => {
      if (channel === 'me' && n === 0) p.fail(new AudioSourceError('mic_denied', 'denied'))
    })
    await t.controller.start(opts())
    expect(t.calls).toContain('warning:mic_denied:true')
    await t.controller.restartChannel('me')
    expect(t.pipe('me', 0).stop).toHaveBeenCalledWith({ flush: false })
    expect(t.calls.at(-1)).toBe('warning:mic_denied:false')
    expect(t.pipelines.filter((p) => p.opts.channel === 'them')).toHaveLength(1)
  })

  it('stop() waits for a microphone switch in progress', async () => {
    const t = setup((p, channel, n) => {
      if (channel === 'me' && n === 1) {
        p.startImpl = async () => {
          p.opts.onStatus('starting', null)
          await wait(30)
          p.opts.onStatus('listening', null)
        }
      }
    })
    await t.controller.start(opts())
    const switching = t.controller.setMicDevice('usb-headset')
    await wait(5) // the new mic is still opening
    await t.controller.stop()
    await switching
    expect(t.pipe('me', 1).stop).toHaveBeenCalledWith({ flush: true })
    expect(t.calls.at(-1)).toBe('stopped:s1')
  })

  it('logs IPC failures instead of throwing', async () => {
    const t = setup()
    t.sink.channelStatus.mockRejectedValue(new Error('main is gone'))
    t.sink.stopped.mockRejectedValue(new Error('main is gone'))
    await t.controller.start(opts())
    await t.controller.stop()
    expect(t.logs.some((l) => /audio:channelStatus failed: main is gone/.test(l))).toBe(true)
    expect(t.logs.some((l) => /audio:stopped failed/.test(l))).toBe(true)
  })
})
