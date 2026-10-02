import { beforeAll, describe, expect, it } from 'vitest'
import {
  createSileroVad,
  loadVadModel,
  vadOptionsForSensitivity,
  type SileroVad,
} from '@renderer/audio/vad'
import { Resampler } from '@renderer/audio/resampler'
import { concat, fixture, frames, useNodeVadRuntime } from './helpers'

/** Real Silero v5 inference (onnxruntime-web WASM running in Node) on the speech fixtures. */

interface Seg {
  startMs: number
  endMs: number
  forced: boolean
  samples: number
}

/** Runs frames through a VAD, mapping segments back to fixture time like the pipeline does. */
async function runVad(
  input: Float32Array[],
  opts: { sensitivity?: number; maxSegmentMs?: number; flushAfter?: number } = {},
) {
  const segments: Seg[] = []
  let processed = 0
  let starts = 0
  let misfires = 0
  const probabilities: number[] = []
  const vad: SileroVad = await createSileroVad({
    sensitivity: opts.sensitivity ?? 0.5,
    maxSegmentMs: opts.maxSegmentMs ?? 12_000,
    onSpeechStart: () => starts++,
    onSpeechEnd: (audio, info) => {
      const n = audio.length / 512
      segments.push({
        startMs: (processed - n) * 32,
        endMs: processed * 32,
        forced: info.forced,
        samples: audio.length,
      })
    },
    onMisfire: () => misfires++,
    onFrame: (p) => probabilities.push(p),
  })
  const limit = opts.flushAfter ?? input.length
  for (let i = 0; i < limit; i++) {
    processed = i + 1
    await vad.process(input[i] as Float32Array)
  }
  const speakingBeforeFlush = vad.speaking
  vad.flush()
  await vad.dispose()
  return { segments, starts, misfires, probabilities, speakingBeforeFlush }
}

// The fixture is espeak speech: 0.8 s lead silence, speech to ~6.65 s with a 0.39 s gap
// near 3.6 s, then silence to 8.54 s.
let speech16: Float32Array

beforeAll(async () => {
  useNodeVadRuntime()
  speech16 = fixture('speech-en-16k.wav').samples
  await loadVadModel()
})

describe('vadOptionsForSensitivity', () => {
  it('maps 0..1 to Silero thresholds', () => {
    expect(vadOptionsForSensitivity(0.5)).toEqual({
      positiveSpeechThreshold: expect.closeTo(0.5, 9),
      negativeSpeechThreshold: expect.closeTo(0.35, 9),
      redemptionMs: 400,
      preSpeechPadMs: 200,
      minSpeechMs: 250,
      submitUserSpeechOnPause: false,
    })
    expect(vadOptionsForSensitivity(0).positiveSpeechThreshold).toBeCloseTo(0.7, 9)
    expect(vadOptionsForSensitivity(1).positiveSpeechThreshold).toBeCloseTo(0.3, 9)
    expect(vadOptionsForSensitivity(1).negativeSpeechThreshold).toBeCloseTo(0.15, 9)
    expect(vadOptionsForSensitivity(7).positiveSpeechThreshold).toBeCloseTo(0.3, 9)
    expect(vadOptionsForSensitivity(Number.NaN).positiveSpeechThreshold).toBeCloseTo(0.5, 9)
  })
})

describe('Silero VAD (real model)', () => {
  it('shares one model load across instances', async () => {
    expect(loadVadModel()).toBe(loadVadModel())
    const bytes = await loadVadModel()
    expect(bytes.byteLength).toBeGreaterThan(1_000_000)
  })

  it('finds the speech in the 16 kHz fixture', async () => {
    const { segments, probabilities } = await runVad(frames(speech16))
    expect(segments.length).toBeGreaterThanOrEqual(1)
    expect(segments.length).toBeLessThanOrEqual(3)
    expect(segments.every((s) => !s.forced)).toBe(true)
    const first = segments[0] as Seg
    const last = segments[segments.length - 1] as Seg
    // Starts ~200 ms (pre-pad) before the speech at 0.8 s; ends ≤ ~0.5 s after it stops.
    expect(first.startMs).toBeGreaterThan(300)
    expect(first.startMs).toBeLessThan(900)
    expect(last.endMs).toBeGreaterThan(6400)
    expect(last.endMs).toBeLessThan(7400)
    for (const s of segments) {
      expect(s.samples % 512).toBe(0)
      expect(s.endMs - s.startMs).toBeGreaterThanOrEqual(250)
    }
    // Leading silence is confidently non-speech.
    expect(Math.max(...probabilities.slice(0, 15))).toBeLessThan(0.3)
  })

  it('force-cuts continuous speech at the max segment length and keeps listening', async () => {
    const { segments } = await runVad(frames(speech16), { maxSegmentMs: 1500 })
    expect(segments.length).toBeGreaterThanOrEqual(3)
    expect(segments.some((s) => s.forced)).toBe(true)
    for (const s of segments) expect(s.endMs - s.startMs).toBeLessThanOrEqual(1500)
    // Coverage is not lost: speech up to ~6.6 s is still segmented.
    expect(segments[segments.length - 1]?.endMs).toBeGreaterThan(6000)
  })

  it('flush() emits the speech in progress', async () => {
    // Stop 2.5 s in, mid-sentence.
    const result = await runVad(frames(speech16), { flushAfter: Math.round(2500 / 32) })
    expect(result.speakingBeforeFlush).toBe(true)
    expect(result.segments).toHaveLength(1)
    expect(result.segments[0]?.forced).toBe(false)
    expect(result.segments[0]?.endMs).toBe(Math.round(2500 / 32) * 32)
  })

  it('ignores silence and quiet noise', async () => {
    const noise = new Float32Array(16_000 * 3)
    let seed = 1
    for (let i = 0; i < noise.length; i++) {
      seed = (seed * 16807) % 2147483647
      noise[i] = (seed / 2147483647 - 0.5) * 0.002
    }
    const { segments, starts } = await runVad(frames(concat([new Float32Array(16_000), noise])))
    expect(segments).toHaveLength(0)
    expect(starts).toBe(0)
  })

  it('agrees on the 48 kHz fixture after Bluely’s resampler', async () => {
    const r = new Resampler(48_000)
    const resampled = concat([r.process(fixture('speech-en-48k.wav').samples), r.flush()])
    const direct = await runVad(frames(speech16))
    const viaResampler = await runVad(frames(resampled))
    expect(viaResampler.segments.length).toBe(direct.segments.length)
    viaResampler.segments.forEach((s, i) => {
      expect(Math.abs(s.startMs - (direct.segments[i] as Seg).startMs)).toBeLessThanOrEqual(64)
      expect(Math.abs(s.endMs - (direct.segments[i] as Seg).endMs)).toBeLessThanOrEqual(64)
    })
  })

  it('skips inference on digital silence between utterances (idle CPU)', async () => {
    const make = (silenceGateDbfs?: number | null) =>
      createSileroVad({
        sensitivity: 0.5,
        maxSegmentMs: 12_000,
        onSpeechStart: () => undefined,
        onSpeechEnd: () => undefined,
        ...(silenceGateDbfs !== undefined ? { silenceGateDbfs } : {}),
      })
    const gated = await make()
    for (let i = 0; i < 31; i++) await gated.process(new Float32Array(512))
    expect(gated.stats).toEqual({ frames: 31, inferences: 0 })
    const speechFrames = frames(speech16).slice(25, 60) // 0.8–1.9 s: speech
    for (const f of speechFrames) await gated.process(f)
    expect(gated.stats.inferences).toBe(speechFrames.length)
    expect(gated.speaking).toBe(true)
    await gated.dispose()

    const ungated = await make(null)
    for (let i = 0; i < 10; i++) await ungated.process(new Float32Array(512))
    expect(ungated.stats).toEqual({ frames: 10, inferences: 10 })
    await ungated.dispose()
  })

  it('gating does not change what is detected on the fixture', async () => {
    const withGate = await runVad(frames(concat([new Float32Array(32_000), speech16])))
    expect(withGate.segments.length).toBeGreaterThanOrEqual(1)
    expect(withGate.segments[0]?.startMs).toBeGreaterThan(2300)
    expect(withGate.segments[0]?.startMs).toBeLessThan(2900)
  })

  it('applies sensitivity changes and is inert after dispose', async () => {
    const vad = await createSileroVad({
      sensitivity: 0.5,
      maxSegmentMs: 12_000,
      onSpeechStart: () => undefined,
      onSpeechEnd: () => undefined,
    })
    vad.setSensitivity(0)
    vad.setMaxSegmentMs(4000)
    await vad.process(new Float32Array(512))
    await vad.dispose()
    await vad.dispose()
    await expect(vad.process(new Float32Array(512))).resolves.toBeUndefined()
    expect(() => vad.flush()).not.toThrow()
  })
})
