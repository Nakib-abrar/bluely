import { describe, expect, it, vi } from 'vitest'
import type { ChannelState } from '@shared/types'
import {
  ChannelPipeline,
  MAX_QUEUED_FRAMES,
  type ChannelPipelineOptions,
  type PipelineSegment,
} from '@renderer/audio/channelPipeline'
import type { CaptureGraph, CaptureGraphHandlers } from '@renderer/audio/captureGraph'
import { AudioSourceError, type AudioSource } from '@renderer/audio/sources'
import type { SileroVad, SileroVadOptions } from '@renderer/audio/vad'

const T0 = 1_000_000

class FakeTrack extends EventTarget {
  readonly kind = 'audio'
  muted = false
  stopped = false
  stop() {
    this.stopped = true
  }
}

function fakeSource(kind: 'mic' | 'loopback' = 'mic') {
  const track = new FakeTrack()
  const stream = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream
  const source = {
    kind,
    start: vi.fn(async () => stream),
    stop: vi.fn(() => track.stop()),
  } satisfies AudioSource
  return { source, track, stream }
}

/** Frames carry their own index in sample 0 so the fake VAD can script events. */
const frame = (i: number) => {
  const f = new Float32Array(512)
  f[0] = i
  return f
}

class FakeVad implements SileroVad {
  processed: number[] = []
  flushed = 0
  disposed = false
  speaking = false
  stats = { frames: 0, inferences: 0 }
  /** Called for each processed frame; may return a promise to simulate slow inference. */
  onProcess: (index: number) => Promise<void> | void = () => undefined
  constructor(readonly opts: SileroVadOptions) {}
  async process(f: Float32Array) {
    const index = f[0] as number
    this.processed.push(index)
    await this.onProcess(index)
  }
  /** Emits a segment made of the last `frames` frames. */
  end(frames: number, forced = false) {
    this.opts.onSpeechEnd(new Float32Array(frames * 512), { forced })
  }
  flush() {
    this.flushed++
  }
  setSensitivity = vi.fn()
  setMaxSegmentMs = vi.fn()
  async dispose() {
    this.disposed = true
  }
}

function setup(overrides: Partial<ChannelPipelineOptions> = {}, kind: 'mic' | 'loopback' = 'mic') {
  const { source, track } = fakeSource(kind)
  let vad: FakeVad | null = null
  let handlers: CaptureGraphHandlers | null = null
  const graph = { closed: false }
  const statuses: { state: ChannelState; error: AudioSourceError | null }[] = []
  const segments: PipelineSegment[] = []
  const levels: number[] = []
  const speaking: boolean[] = []
  const muted: boolean[] = []
  const opts: ChannelPipelineOptions = {
    channel: 'me',
    source,
    sensitivity: 0.5,
    maxSegmentMs: 12_000,
    onSegment: (s) => segments.push(s),
    onLevel: (r) => levels.push(r),
    onSpeaking: (s) => speaking.push(s),
    onStatus: (state, error) => statuses.push({ state, error }),
    onMuted: (m) => muted.push(m),
    now: () => T0,
    createVad: async (o) => {
      vad = new FakeVad(o)
      return vad
    },
    openGraph: async (_stream, h) => {
      handlers = h
      h.onStarted?.({
        contextTime: 0,
        inputSampleRate: 48_000,
        anchor: { epochMs: T0, contextTime: 0 },
      })
      return {
        context: {} as AudioContext,
        sampleRate: 48_000,
        timestamp: () => ({ epochMs: T0, contextTime: 0 }),
        close: async () => {
          graph.closed = true
        },
      } satisfies CaptureGraph
    },
    ...overrides,
  }
  const pipeline = new ChannelPipeline(opts)
  return {
    pipeline,
    source,
    track,
    graph,
    statuses,
    segments,
    levels,
    speaking,
    muted,
    vad: () => vad as unknown as FakeVad,
    push: (i: number, rms = 0.1) => handlers?.onFrame(frame(i), rms, i),
  }
}

const settle = () => new Promise((r) => setTimeout(r, 0))

describe('ChannelPipeline', () => {
  it('starts, feeds frames to the VAD in order and reports levels', async () => {
    const t = setup()
    await t.pipeline.start()
    expect(t.statuses.map((s) => s.state)).toEqual(['starting', 'listening'])
    expect(t.pipeline.state).toBe('listening')
    for (let i = 0; i < 10; i++) t.push(i, i / 10)
    await settle()
    expect(t.vad().processed).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(t.levels).toHaveLength(10)
    expect(t.levels[9]).toBeCloseTo(0.9, 9)
  })

  it('timestamps segments from frame indices', async () => {
    const t = setup()
    await t.pipeline.start()
    t.vad().onProcess = (i) => {
      if (i === 5) t.vad().opts.onSpeechStart()
      if (i === 14) t.vad().end(10) // frames 5..14
    }
    for (let i = 0; i < 20; i++) t.push(i)
    await settle()
    expect(t.speaking).toEqual([true, false])
    expect(t.segments).toHaveLength(1)
    const seg = t.segments[0] as PipelineSegment
    expect(seg.channel).toBe('me')
    expect(seg.startedAt).toBe(T0 + 5 * 32)
    expect(seg.endedAt).toBe(T0 + 15 * 32)
    expect(seg.vadEndAt).toBe(T0)
    expect(seg.forced).toBe(false)
    expect(seg.samples.length).toBe(10 * 512)
  })

  it('drops the oldest frames when the VAD falls behind, keeping timestamps right', async () => {
    const t = setup()
    await t.pipeline.start()
    let release: () => void = () => undefined
    t.vad().onProcess = (i) => {
      if (i === 0) return new Promise<void>((r) => (release = r))
      if (i === 99) t.vad().end(MAX_QUEUED_FRAMES + 1) // frame 0 + the 63 frames kept
    }
    for (let i = 0; i < 100; i++) t.push(i)
    expect(t.pipeline.droppedFrames).toBe(99 - MAX_QUEUED_FRAMES)
    release()
    await settle()
    const processed = t.vad().processed
    expect(processed[0]).toBe(0)
    expect(processed[1]).toBe(100 - MAX_QUEUED_FRAMES)
    expect(processed.at(-1)).toBe(99)
    expect(t.segments[0]?.startedAt).toBe(T0) // first frame of the segment is frame 0
    expect(t.segments[0]?.endedAt).toBe(T0 + 100 * 32)
  })

  it('stop() processes queued frames, flushes trailing speech and tears down', async () => {
    const t = setup()
    await t.pipeline.start()
    let release: () => void = () => undefined
    t.vad().onProcess = (i) => {
      if (i === 0) return new Promise<void>((r) => (release = r))
    }
    for (let i = 0; i < 5; i++) t.push(i)
    t.vad().flush = vi.fn(() => {
      // All queued frames must have reached the VAD before the flush.
      expect(t.vad().processed).toEqual([0, 1, 2, 3, 4])
      t.vad().end(5)
    })
    const stopping = t.pipeline.stop()
    release()
    await stopping
    expect(t.vad().flush).toHaveBeenCalledTimes(1)
    expect(t.segments).toHaveLength(1)
    expect(t.vad().disposed).toBe(true)
    expect(t.graph.closed).toBe(true)
    expect(t.source.stop).toHaveBeenCalled()
    expect(t.statuses.at(-1)?.state).toBe('off')
    // Frames arriving after teardown are ignored.
    t.push(50)
    await settle()
    expect(t.vad().processed).not.toContain(50)
    await t.pipeline.stop() // idempotent
  })

  it('stop({ flush: false }) discards trailing speech', async () => {
    const t = setup()
    await t.pipeline.start()
    await t.pipeline.stop({ flush: false })
    expect(t.vad().flushed).toBe(0)
  })

  it('reports source failures as error status and rejects start()', async () => {
    const t = setup()
    t.source.start.mockRejectedValueOnce(new AudioSourceError('mic_not_found', 'gone'))
    await expect(t.pipeline.start()).rejects.toMatchObject({ code: 'mic_not_found' })
    expect(t.statuses.map((s) => s.state)).toEqual(['starting', 'error'])
    expect(t.statuses[1]?.error?.code).toBe('mic_not_found')
    expect(t.vad().disposed).toBe(true)
    await t.pipeline.stop()
    expect(t.pipeline.state).toBe('off')
  })

  it('reports a VAD load failure', async () => {
    const t = setup({
      createVad: async () => {
        throw new Error('model 404')
      },
    })
    await expect(t.pipeline.start()).rejects.toMatchObject({ code: 'unknown' })
    expect(t.statuses.at(-1)?.error?.message).toMatch(/Voice detection failed to load: model 404/)
    expect(t.source.stop).toHaveBeenCalled()
    expect(t.graph.closed).toBe(true)
  })

  it('wraps unexpected errors', async () => {
    const t = setup({
      openGraph: async () => {
        throw new Error('AudioContext exploded')
      },
    })
    await expect(t.pipeline.start()).rejects.toBeInstanceOf(AudioSourceError)
    expect(t.statuses.at(-1)?.error?.message).toMatch(/AudioContext exploded/)
  })

  it('a stop() during start() resolves quietly', async () => {
    const t = setup()
    const starting = t.pipeline.start()
    const stopping = t.pipeline.stop()
    await expect(starting).resolves.toBeUndefined()
    await stopping
    expect(t.statuses.map((s) => s.state)).toEqual(['starting', 'off'])
    expect(t.source.stop).toHaveBeenCalled()
  })

  it('a mic that disappears ends in mic_not_found after flushing', async () => {
    const t = setup()
    await t.pipeline.start()
    t.vad().flush = vi.fn(() => t.vad().end(3))
    t.push(0)
    t.push(1)
    t.track.dispatchEvent(new Event('ended'))
    await settle()
    await settle()
    expect(t.segments).toHaveLength(1)
    expect(t.statuses.at(-1)).toMatchObject({ state: 'error', error: { code: 'mic_not_found' } })
    await t.pipeline.stop()
    expect(t.statuses.at(-1)?.state).toBe('off')
  })

  it('loopback ending is loopback_unavailable', async () => {
    const t = setup({ channel: 'them' }, 'loopback')
    await t.pipeline.start()
    t.track.dispatchEvent(new Event('ended'))
    await settle()
    await settle()
    expect(t.statuses.at(-1)).toMatchObject({
      state: 'error',
      error: { code: 'loopback_unavailable' },
    })
  })

  it('forwards mic mute/unmute (and an initially muted track)', async () => {
    const t = setup()
    t.track.muted = true
    await t.pipeline.start()
    t.track.dispatchEvent(new Event('unmute'))
    t.track.dispatchEvent(new Event('mute'))
    t.track.dispatchEvent(new Event('mute'))
    expect(t.muted).toEqual([true, false, true])
    await t.pipeline.stop()
    expect(t.muted.at(-1)).toBe(false)
  })

  it('reports a broken VAD after repeated inference failures', async () => {
    const t = setup()
    await t.pipeline.start()
    t.vad().onProcess = () => {
      throw new Error('ort crashed')
    }
    for (let i = 0; i < 40; i++) t.push(i)
    for (let i = 0; i < 5; i++) await settle()
    expect(t.statuses.at(-1)).toMatchObject({ state: 'error', error: { code: 'unknown' } })
  })

  it('passes VAD setting changes through', async () => {
    const t = setup()
    await t.pipeline.start()
    t.pipeline.setSensitivity(0.9)
    t.pipeline.setMaxSegmentMs(8000)
    expect(t.vad().setSensitivity).toHaveBeenCalledWith(0.9)
    expect(t.vad().setMaxSegmentMs).toHaveBeenCalledWith(8000)
  })
})
