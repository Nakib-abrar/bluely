import { describe, expect, it } from 'vitest'
import {
  FRAME_MS,
  FRAME_SAMPLES,
  SegmentClock,
  VAD_SAMPLE_RATE,
  shouldForceCut,
  speechDurationMs,
} from '@renderer/audio/segmenter'
import { FrameIndexHistory, FrameQueue } from '@renderer/audio/frameQueue'
import { DigitalSilenceDetector, NoSystemAudioDetector } from '@renderer/audio/silenceWatch'

describe('constants', () => {
  it('uses 512-sample, 32 ms frames at 16 kHz', () => {
    expect(VAD_SAMPLE_RATE).toBe(16_000)
    expect(FRAME_SAMPLES).toBe(512)
    expect(FRAME_MS).toBe(32)
  })
})

describe('speechDurationMs', () => {
  it('converts samples to ms', () => {
    expect(speechDurationMs(16_000)).toBe(1000)
    expect(speechDurationMs(512)).toBe(32)
    expect(speechDurationMs(48_000, 48_000)).toBe(1000)
  })
})

describe('SegmentClock', () => {
  it('maps frame indices through AudioContext time to epoch ms', () => {
    // First 16 kHz sample produced at context time 2.5 s; context time 3 s was epoch 1_000_000.
    const clock = new SegmentClock({
      firstSampleContextTime: 2.5,
      anchorEpochMs: 1_000_000,
      anchorContextTime: 3,
    })
    expect(clock.frameStartMs(0)).toBeCloseTo(999_500, 6)
    expect(clock.frameEndMs(0)).toBeCloseTo(999_532, 6)
    expect(clock.frameStartMs(10)).toBeCloseTo(999_820, 6)
    expect(clock.sampleToEpochMs(16_000)).toBeCloseTo(1_000_500, 6)
    expect(clock.span(5, 9)).toEqual({
      startedAt: clock.frameStartMs(5),
      endedAt: clock.frameEndMs(9),
    })
  })

  it('fromEpoch starts sample 0 at the given time', () => {
    const clock = SegmentClock.fromEpoch(5000)
    expect(clock.frameStartMs(0)).toBe(5000)
    expect(clock.frameStartMs(1)).toBe(5032)
    expect(clock.frameEndMs(374)).toBe(5000 + 375 * 32)
  })

  it('reanchors fully or gradually (drift correction without jumps)', () => {
    const clock = SegmentClock.fromEpoch(0)
    // Context time 10 s turned out to be epoch 10_100 (100 ms drift).
    clock.reanchor(10_100, 10, 0.25)
    expect(clock.sampleToEpochMs(160_000)).toBeCloseTo(10_025, 6)
    clock.reanchor(10_100, 10)
    expect(clock.sampleToEpochMs(160_000)).toBeCloseTo(10_100, 6)
    clock.reanchor(0, 0, 5) // weight is clamped to 1
    expect(clock.sampleToEpochMs(0)).toBe(0)
  })
})

describe('shouldForceCut', () => {
  it('cuts exactly at the cap', () => {
    expect(shouldForceCut(374, 12_000)).toBe(false)
    expect(shouldForceCut(375, 12_000)).toBe(true) // 375 × 32 ms = 12 s; one more would exceed
    expect(shouldForceCut(400, 12_000)).toBe(true)
    expect(shouldForceCut(124, 4000)).toBe(false)
    expect(shouldForceCut(125, 4000)).toBe(true)
    // Caps that are not a whole number of frames round down: 1.5 s → 46 frames (1.472 s).
    expect(shouldForceCut(45, 1500)).toBe(false)
    expect(shouldForceCut(46, 1500)).toBe(true)
  })

  it('may cut early at a pause inside the soft window only', () => {
    const opts = { frameProb: 0.1, pauseThreshold: 0.35 }
    // Soft window for 12 s = 2 s → from 10 s (312.5 frames).
    expect(shouldForceCut(300, 12_000, opts)).toBe(false)
    expect(shouldForceCut(313, 12_000, opts)).toBe(true)
    expect(shouldForceCut(313, 12_000, { frameProb: 0.9, pauseThreshold: 0.35 })).toBe(false)
    // Soft window for 4 s = 1 s (25 %).
    expect(shouldForceCut(90, 4000, opts)).toBe(false)
    expect(shouldForceCut(94, 4000, opts)).toBe(true)
    expect(shouldForceCut(94, 4000, { ...opts, softWindowMs: 0 })).toBe(false)
  })
})

describe('FrameQueue', () => {
  it('is FIFO and drops the oldest frame when full', () => {
    const q = new FrameQueue(3)
    const f = (v: number) => new Float32Array([v])
    expect(q.push(f(0), 0)).toBe(false)
    q.push(f(1), 1)
    q.push(f(2), 2)
    expect(q.push(f(3), 3)).toBe(true)
    expect(q.length).toBe(3)
    expect(q.droppedCount).toBe(1)
    expect(q.shift()?.[0]).toBe(1)
    expect(q.lastShiftedIndex).toBe(1)
    q.push(f(4), 4)
    expect([q.shift()?.[0], q.shift()?.[0], q.shift()?.[0]]).toEqual([2, 3, 4])
    expect(q.lastShiftedIndex).toBe(4)
    expect(q.shift()).toBeNull()
    q.push(f(5), 5)
    q.clear()
    expect(q.length).toBe(0)
    expect(() => new FrameQueue(0)).toThrow(RangeError)
  })
})

describe('FrameIndexHistory', () => {
  it('returns recent indices and extrapolates beyond its window', () => {
    const h = new FrameIndexHistory(4)
    expect(h.fromEnd(1)).toBe(-1)
    for (const i of [10, 11, 13, 14, 15]) h.push(i) // 12 was dropped upstream
    expect(h.size).toBe(4)
    expect(h.fromEnd(1)).toBe(15)
    expect(h.fromEnd(3)).toBe(13)
    expect(h.fromEnd(4)).toBe(11)
    expect(h.fromEnd(6)).toBe(9) // beyond the window: assume contiguous
    h.clear()
    expect(h.size).toBe(0)
  })
})

describe('NoSystemAudioDetector', () => {
  const quiet = 0.001 // −60 dBFS
  const loud = 0.05 // −26 dBFS

  it('warns after 20 s of Them silence while Me spoke, and clears when Them returns', () => {
    const d = new NoSystemAudioDetector()
    d.start(0)
    for (let t = 0; t < 19_000; t += 1000) {
      d.meSpeech(t)
      expect(d.themLevel(quiet, t)).toBe(false)
    }
    expect(d.themLevel(quiet, 20_000)).toBe(true)
    expect(d.active).toBe(true)
    // Stays active while Them stays quiet, even when Me stops talking.
    expect(d.themLevel(quiet, 60_000)).toBe(true)
    expect(d.themLevel(loud, 61_000)).toBe(false)
    expect(d.active).toBe(false)
  })

  it('does not warn when nobody talks or Me only spoke before the silence', () => {
    const d = new NoSystemAudioDetector()
    d.start(0)
    expect(d.themLevel(quiet, 30_000)).toBe(false)
    d.meSpeech(31_000)
    expect(d.evaluate(31_000)).toBe(true) // silence ≥ 20 s and Me spoke during it

    const e = new NoSystemAudioDetector()
    e.start(0)
    e.meSpeech(1000)
    e.themLevel(loud, 2000) // Them was audible after Me spoke
    expect(e.themLevel(quiet, 25_000)).toBe(false)
  })

  it('honours custom thresholds and stop()', () => {
    const d = new NoSystemAudioDetector({ thresholdDbfs: -30, afterMs: 5000 })
    d.start(0)
    d.meSpeech(1000)
    expect(d.themLevel(0.02, 6000)).toBe(true) // −34 dBFS counts as silence here
    d.stop()
    expect(d.active).toBe(false)
    expect(d.themLevel(quiet, 10_000)).toBe(false)
    expect(d.meSpeech(10_000)).toBe(false)
  })
})

describe('DigitalSilenceDetector', () => {
  it('flags only sustained exact silence', () => {
    const d = new DigitalSilenceDetector()
    expect(d.update(0, 0)).toBe(false)
    expect(d.update(1e-7, 4999)).toBe(false)
    expect(d.update(0, 5000)).toBe(true)
    expect(d.active).toBe(true)
    expect(d.update(0.0001, 5100)).toBe(false) // −80 dBFS is a live (quiet) mic
    expect(d.update(0, 9000)).toBe(false) // the 5 s window restarts
    d.reset()
    expect(d.active).toBe(false)
    const quick = new DigitalSilenceDetector({ thresholdDbfs: -60, afterMs: 100 })
    quick.update(0.0005, 0)
    expect(quick.update(0.0005, 100)).toBe(true)
  })
})
