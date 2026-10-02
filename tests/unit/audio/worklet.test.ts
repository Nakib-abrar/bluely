import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CaptureWorkletMessage } from '@renderer/audio/worklets/protocol'
import { goertzelPower } from '@renderer/audio/goertzel'
import { concat, sine } from './helpers'

/**
 * Runs the real AudioWorkletProcessor module in Node by providing the few
 * AudioWorkletGlobalScope globals it uses.
 */
interface Posted {
  message: CaptureWorkletMessage
  transfer: Transferable[] | undefined
}

class FakePort {
  posted: Posted[] = []
  onmessage: ((e: MessageEvent) => void) | null = null
  postMessage(message: CaptureWorkletMessage, transfer?: Transferable[]) {
    this.posted.push({ message, transfer })
  }
}

type ProcessorCtor = new () => {
  port: FakePort
  process(inputs: Float32Array[][]): boolean
}

const g = globalThis as unknown as Record<string, unknown>
const registered: { name: string; ctor: ProcessorCtor }[] = []
let Processor: ProcessorCtor

beforeAll(async () => {
  g['sampleRate'] = 48_000
  g['currentTime'] = 1.25
  g['AudioWorkletProcessor'] = class {
    readonly port = new FakePort()
  }
  g['registerProcessor'] = vi.fn((name: string, ctor: ProcessorCtor) => {
    registered.push({ name, ctor })
  })
  const mod = await import('@renderer/audio/worklets/capture.worklet')
  Processor = mod.CaptureProcessor as unknown as ProcessorCtor
})

afterAll(() => {
  for (const key of ['sampleRate', 'currentTime', 'AudioWorkletProcessor', 'registerProcessor']) {
    delete g[key]
  }
})

/** Feeds `channels` to a processor in 128-sample render quanta. */
function run(proc: { process(inputs: Float32Array[][]): boolean }, channels: Float32Array[]) {
  const length = channels[0]?.length ?? 0
  for (let i = 0; i < length; i += 128) {
    proc.process([channels.map((c) => c.slice(i, i + 128))])
  }
}

function framesOf(port: FakePort) {
  return port.posted
    .map((p) => p.message)
    .filter((m): m is Extract<CaptureWorkletMessage, { type: 'frame' }> => m.type === 'frame')
}

describe('capture worklet', () => {
  it("registers as 'bluely-capture'", () => {
    expect(registered.map((r) => r.name)).toEqual(['bluely-capture'])
  })

  it('downmixes stereo 48 kHz to 16 kHz 512-sample frames with RMS', () => {
    g['sampleRate'] = 48_000
    const proc = new Processor()
    const left = sine(440, 48_000, 1, 0.5)
    const right = sine(440, 48_000, 1, 0.3)
    run(proc, [left, right])

    const first = proc.port.posted[0]?.message
    expect(first).toEqual({ type: 'started', contextTime: 1.25, inputSampleRate: 48_000 })

    const frames = framesOf(proc.port)
    expect(frames.length).toBe(31) // 16 000 samples − ~25 of filter delay = 31 full frames
    frames.forEach((f, i) => {
      expect(f.index).toBe(i)
      expect(f.frame.length).toBe(512)
    })
    // Frame buffers are transferred, not copied.
    const framePosts = proc.port.posted.filter((p) => p.message.type === 'frame')
    framePosts.forEach((p) => {
      const msg = p.message as Extract<CaptureWorkletMessage, { type: 'frame' }>
      expect(p.transfer).toEqual([msg.frame.buffer])
    })
    // (0.5 + 0.3) / 2 = 0.4 amplitude → RMS 0.283 once the filter has warmed up.
    expect(frames[5]?.rms).toBeCloseTo(0.4 / Math.SQRT2, 2)
    const audio = concat(frames.map((f) => f.frame))
    const amp = Math.sqrt(2 * goertzelPower(audio, 16_000, 440, 512, 512 + 8000))
    expect(amp).toBeCloseTo(0.4, 2)
  })

  it('resamples 44.1 kHz input and keeps frame cadence', () => {
    g['sampleRate'] = 44_100
    const proc = new Processor()
    run(proc, [sine(1000, 44_100, 2, 0.5)])
    const frames = framesOf(proc.port)
    expect(frames.length).toBe(62) // 32 000 samples / 512, minus the filter delay
    const audio = concat(frames.map((f) => f.frame))
    expect(Math.sqrt(2 * goertzelPower(audio, 16_000, 1000, 1600, 1600 + 16_000))).toBeCloseTo(
      0.5,
      2,
    )
  })

  it('stays alive without input and stops on command', () => {
    g['sampleRate'] = 48_000
    const proc = new Processor()
    expect(proc.process([[]])).toBe(true)
    expect(proc.process([])).toBe(true)
    expect(proc.port.posted).toHaveLength(0)
    proc.port.onmessage?.({ data: { type: 'stop' } } as MessageEvent)
    expect(proc.process([[new Float32Array(128)]])).toBe(false)
  })

  it('handles render quanta larger than 128 samples', () => {
    g['sampleRate'] = 16_000
    const proc = new Processor()
    proc.process([[new Float32Array(1024).fill(0.25)]])
    const frames = framesOf(proc.port)
    expect(frames).toHaveLength(2)
    expect(frames[1]?.rms).toBeCloseTo(0.25, 6)
  })
})
