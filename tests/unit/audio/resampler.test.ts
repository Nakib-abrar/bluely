import { describe, expect, it } from 'vitest'
import { Resampler, downmix, downmixInto } from '@renderer/audio/resampler'
import { goertzelPower, rms } from '@renderer/audio/goertzel'
import { concat, rng, sine } from './helpers'

const OUT = 16_000

/** Resamples a whole signal (including the filter tail) in one go. */
function resampleAll(input: Float32Array, inRate: number, outRate = OUT): Float32Array {
  const r = new Resampler(inRate, outRate)
  return concat([r.process(input), r.flush()])
}

/** Amplitude of the `freq` component, measured over `[start, end)` of `samples`. */
function amplitudeAt(
  samples: Float32Array,
  rate: number,
  freq: number,
  start: number,
  end: number,
) {
  return Math.sqrt(2 * goertzelPower(samples, rate, freq, start, end))
}

const db = (ratio: number) => 20 * Math.log10(ratio)

describe('downmix', () => {
  it('averages channels and copies mono', () => {
    const left = new Float32Array([1, 0.5, -1])
    const right = new Float32Array([0, 0.5, 1])
    expect(Array.from(downmix([left, right]))).toEqual([0.5, 0.5, 0])
    const mono = downmix([left])
    expect(Array.from(mono)).toEqual([1, 0.5, -1])
    expect(mono).not.toBe(left)
  })

  it('downmixInto writes into a preallocated buffer and handles no channels', () => {
    const out = new Float32Array(4).fill(9)
    downmixInto([new Float32Array([0.2, 0.4]), new Float32Array([0.4, 0.2])], out, 2)
    expect(out[0]).toBeCloseTo(0.3, 6)
    expect(out[1]).toBeCloseTo(0.3, 6)
    expect(out[2]).toBe(9)
    downmixInto([], out, 4)
    expect(Array.from(out)).toEqual([0, 0, 0, 0])
  })
})

describe('Resampler', () => {
  it.each([44_100, 48_000, 96_000])(
    'keeps a 440 Hz sine at %i Hz → 16 kHz within ±1 dB, peak at 440 Hz',
    (inRate) => {
      const amp = 0.5
      const out = resampleAll(sine(440, inRate, 2, amp), inRate)
      expect(Math.abs(out.length - 2 * OUT)).toBeLessThanOrEqual(2)
      // Skip the filter warm-up; analyse an integer number of 440 Hz cycles (1 s = 440).
      const start = 1600
      const end = start + OUT
      const measured = amplitudeAt(out, OUT, 440, start, end)
      expect(Math.abs(db(measured / amp))).toBeLessThan(1)
      expect(Math.abs(db(measured / amp))).toBeLessThan(0.05) // in practice: flat passband
      // The spectral peak is at 440 Hz.
      let best = 0
      let bestPower = -1
      for (let f = 300; f <= 600; f += 5) {
        const p = goertzelPower(out, OUT, f, start, end)
        if (p > bestPower) {
          bestPower = p
          best = f
        }
      }
      expect(best).toBe(440)
    },
  )

  it('is zero-phase: output n sits at input time n × step', () => {
    const amp = 0.5
    const inRate = 44_100
    const out = resampleAll(sine(440, inRate, 1, amp), inRate)
    let maxErr = 0
    for (let n = 800; n < 15_000; n++) {
      const ideal = amp * Math.sin((2 * Math.PI * 440 * n) / OUT)
      maxErr = Math.max(maxErr, Math.abs((out[n] as number) - ideal))
    }
    expect(maxErr).toBeLessThan(1e-3)
  })

  it('keeps the speech band flat (±0.5 dB from 100 Hz to 6 kHz)', () => {
    for (const freq of [100, 300, 1000, 3000, 5000, 6000]) {
      const out = resampleAll(sine(freq, 48_000, 1.2, 0.5), 48_000)
      const measured = amplitudeAt(out, OUT, freq, 1600, 1600 + 16_000)
      expect(Math.abs(db(measured / 0.5)), `${freq} Hz`).toBeLessThan(0.5)
    }
  })

  it('attenuates an 11 kHz tone at 48 kHz by ≥ 40 dB (anti-aliasing)', () => {
    const amp = 0.5
    const out = resampleAll(sine(11_000, 48_000, 1, amp), 48_000)
    const steady = out.subarray(800, out.length - 800)
    const inputRms = amp / Math.SQRT2
    const attenuation = db(inputRms / Math.max(rms(steady), 1e-12))
    expect(attenuation).toBeGreaterThanOrEqual(40)
    // 11 kHz would alias to 5 kHz: nothing must show up there.
    const alias = amplitudeAt(steady, OUT, 5000, 0, steady.length)
    expect(db(amp / Math.max(alias, 1e-12))).toBeGreaterThanOrEqual(40)
  })

  it('attenuates out-of-band tones at 44.1 and 96 kHz by ≥ 40 dB', () => {
    for (const [inRate, freq] of [
      [44_100, 9_000],
      [44_100, 15_000],
      [96_000, 20_000],
      [96_000, 40_000],
    ] as const) {
      const out = resampleAll(sine(freq, inRate, 1, 0.5), inRate)
      const steady = out.subarray(800, out.length - 800)
      expect(
        db(0.5 / Math.SQRT2 / Math.max(rms(steady), 1e-12)),
        `${freq}@${inRate}`,
      ).toBeGreaterThanOrEqual(40)
    }
  })

  it('gives identical output however the input is split into blocks (no clicks)', () => {
    const random = rng(42)
    for (const inRate of [44_100, 48_000, 96_000]) {
      const input = concat([sine(440, inRate, 0.7, 0.4), sine(1234, inRate, 0.5, 0.3, 1)])
      const whole = new Resampler(inRate).process(input)
      const r = new Resampler(inRate)
      const parts: Float32Array[] = []
      for (let i = 0; i < input.length;) {
        const size = 1 + Math.floor(random() * 997)
        parts.push(r.process(input.subarray(i, Math.min(input.length, i + size))))
        i += size
      }
      const chunked = concat(parts)
      expect(chunked.length).toBe(whole.length)
      let maxDiff = 0
      for (let i = 0; i < whole.length; i++) {
        maxDiff = Math.max(maxDiff, Math.abs((whole[i] as number) - (chunked[i] as number)))
      }
      expect(maxDiff).toBeLessThan(1e-6)
    }
  })

  it('has no discontinuities across 128-sample render quanta', () => {
    const amp = 0.5
    const input = sine(440, 48_000, 1, amp)
    const r = new Resampler(48_000)
    const out = new Float32Array(r.maxOutputLength(128))
    const collected: number[] = []
    // Like the worklet: a reused staging buffer larger than the valid length.
    const staging = new Float32Array(256).fill(99)
    for (let i = 0; i < input.length; i += 128) {
      staging.set(input.subarray(i, i + 128))
      const count = r.processInto(staging, out, 128)
      for (let k = 0; k < count; k++) collected.push(out[k] as number)
    }
    // A 440 Hz sine sampled at 16 kHz never moves more than 2π·440/16000·A per sample.
    const maxStep = ((2 * Math.PI * 440) / OUT) * amp * 1.01
    for (let i = 400; i < collected.length - 1; i++) {
      expect(Math.abs((collected[i + 1] as number) - (collected[i] as number))).toBeLessThan(
        maxStep,
      )
    }
  })

  it('passes 16 kHz through unchanged', () => {
    const input = sine(440, OUT, 0.1)
    const r = new Resampler(OUT)
    expect(r.passthrough).toBe(true)
    const out = r.process(input)
    expect(Array.from(out)).toEqual(Array.from(input))
    expect(out).not.toBe(input)
    expect(r.flush().length).toBe(0)
  })

  it('upsamples 8 kHz to 16 kHz without losing a 440 Hz tone', () => {
    const out = resampleAll(sine(440, 8000, 1.2, 0.5), 8000)
    const measured = amplitudeAt(out, OUT, 440, 1600, 1600 + 16_000)
    expect(Math.abs(db(measured / 0.5))).toBeLessThan(0.1)
  })

  it('keeps the latency small and bounds the output size', () => {
    const r = new Resampler(48_000)
    expect(r.latencySec).toBeLessThan(0.003)
    expect(r.maxOutputLength(128)).toBeGreaterThanOrEqual(Math.ceil(128 / 3))
  })

  it('rejects invalid rates', () => {
    expect(() => new Resampler(0)).toThrow(RangeError)
    expect(() => new Resampler(Number.NaN)).toThrow(RangeError)
    expect(() => new Resampler(48_000, -1)).toThrow(RangeError)
  })
})
