/**
 * Settings › "Test system audio": plays a short two-tone signal on the default output
 * device and checks that the desktop loopback capture (the Them channel) hears it.
 */
import { openCaptureGraph, type CaptureGraph } from './captureGraph'
import { goertzelPower, powerToDb, sinePowerToDbfs } from './goertzel'
import { VAD_SAMPLE_RATE } from './segmenter'
import { LoopbackSource } from './sources'

export interface SystemAudioTestResult {
  ok: boolean
  /** Level of the captured test tone in dBFS (per tone; ~-12 at 100 % system volume). */
  detectedDb: number | null
  /** Why the test failed (plain English for now; see SYSTEM_AUDIO_TEST_REASONS). */
  reason: string | null
}

/**
 * Failure reasons. Plain English until the settings UI owns an i18n namespace for them;
 * the integrator can map these exact strings (or keys) to t() keys.
 */
export const SYSTEM_AUDIO_TEST_REASONS = {
  loopbackUnavailable:
    'System audio capture is not available, so Bluely cannot hear the other side of calls.',
  noAudio: 'System audio capture started but delivered no audio.',
  playbackFailed: 'Bluely could not play the test tone on the default output device.',
  notDetected:
    'The test tone was not heard in the system audio. Make sure calls play through the default output device and that it is not muted.',
  tooQuiet:
    'The test tone was too faint compared with other sound playing on this PC. Pause other audio and try again.',
} as const

/** The two test tones (Hz) and two in-between reference frequencies used as a noise gauge. */
export const TONE_FREQUENCIES = [1000, 1500] as const
const REFERENCE_FREQUENCIES = [1250, 1750] as const
const TONE_SECONDS = 1.5
const TONE_GAIN = 0.25
const BASELINE_MS = 500
/** Capture continues this long after the tone so output + loopback latency is covered. */
const TAIL_MS = 700
const FIRST_FRAME_TIMEOUT_MS = 3000
/** 100 ms analysis blocks: every tone/reference frequency has a whole number of cycles. */
const BLOCK_SAMPLES = VAD_SAMPLE_RATE / 10
/** Strongest blocks averaged as "the tone" (the tone spans ~15 blocks; latency is unknown). */
const TOP_BLOCKS = 10
export const REQUIRED_MARGIN_DB = 15
/** Below this the "tone" is numerical dust, whatever the margin over digital silence. */
export const MIN_TONE_DBFS = -70
/** Noise floor used when the baseline is digital silence (−140 dB). */
const NOISE_FLOOR_POWER = 1e-14

export interface ToneAnalysis {
  ok: boolean
  /** Tone level per frequency, dBFS. */
  detectedDb: number
  /** Tone power over the noise floor, dB. */
  marginDb: number
  tonePower: number
  noisePower: number
}

function mean(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0
}

function median(values: number[]): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
}

function blockPower(
  samples: Float32Array,
  start: number,
  freqs: readonly number[],
  sampleRate: number,
): number {
  return mean(freqs.map((f) => goertzelPower(samples, sampleRate, f, start, start + BLOCK_SAMPLES)))
}

/**
 * Decides whether the tone is present in `samples` (16 kHz), whose first `baselineSamples`
 * were captured before the tone started. Tone power = mean of the strongest 100 ms blocks at
 * the tone frequencies; noise floor = the louder of the pre-tone level at those frequencies
 * and the level at in-between reference frequencies during the same blocks (catches
 * broadband sound such as music playing). ok when tone ≥ noise + 15 dB. Pure.
 */
export function analyzeToneCapture(
  samples: Float32Array,
  baselineSamples: number,
  sampleRate: number = VAD_SAMPLE_RATE,
): ToneAnalysis {
  const baseline: number[] = []
  for (let s = 0; s + BLOCK_SAMPLES <= baselineSamples; s += BLOCK_SAMPLES) {
    baseline.push(blockPower(samples, s, TONE_FREQUENCIES, sampleRate))
  }
  const blocks: { tone: number; reference: number }[] = []
  for (let s = baselineSamples; s + BLOCK_SAMPLES <= samples.length; s += BLOCK_SAMPLES) {
    blocks.push({
      tone: blockPower(samples, s, TONE_FREQUENCIES, sampleRate),
      reference: blockPower(samples, s, REFERENCE_FREQUENCIES, sampleRate),
    })
  }
  blocks.sort((a, b) => b.tone - a.tone)
  const top = blocks.slice(0, TOP_BLOCKS)
  const tonePower = mean(top.map((b) => b.tone))
  const noisePower = Math.max(
    median(baseline),
    mean(top.map((b) => b.reference)),
    NOISE_FLOOR_POWER,
  )
  const marginDb = powerToDb(tonePower) - powerToDb(noisePower)
  const detectedDb = sinePowerToDbfs(tonePower)
  return {
    ok: top.length > 0 && marginDb >= REQUIRED_MARGIN_DB && detectedDb >= MIN_TONE_DBFS,
    detectedDb,
    marginDb,
    tonePower,
    noisePower,
  }
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted', 'AbortError')
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError())
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Plays the two-tone test signal on the default output device; resolves when it ended. */
async function playTestTone(signal?: AbortSignal): Promise<void> {
  const ctx = new AudioContext()
  try {
    if (ctx.state !== 'running') await ctx.resume()
    const master = ctx.createGain()
    master.gain.value = 0
    master.connect(ctx.destination)
    const t0 = ctx.currentTime + 0.05
    const t1 = t0 + TONE_SECONDS
    // 20 ms ramps: no clicks (which would splatter energy across the reference bins).
    master.gain.setValueAtTime(0, t0)
    master.gain.linearRampToValueAtTime(TONE_GAIN, t0 + 0.02)
    master.gain.setValueAtTime(TONE_GAIN, t1 - 0.02)
    master.gain.linearRampToValueAtTime(0, t1)
    for (const freq of TONE_FREQUENCIES) {
      const osc = new OscillatorNode(ctx, { type: 'sine', frequency: freq })
      osc.connect(master)
      osc.start(t0)
      osc.stop(t1 + 0.02)
    }
    await sleep(Math.max(0, (t1 - ctx.currentTime) * 1000) + 60, signal)
  } finally {
    await ctx.close().catch(() => undefined)
  }
}

/**
 * Runs the system audio check (~3 s): opens the loopback capture, measures 0.5 s of
 * baseline, plays a 1 kHz + 1.5 kHz tone for 1.5 s and looks for it in the captured 16 kHz
 * stream. Never rejects except with an AbortError DOMException when `signal` aborts.
 */
export async function testSystemAudio(
  opts: { signal?: AbortSignal } = {},
): Promise<SystemAudioTestResult> {
  const { signal } = opts
  if (signal?.aborted) throw abortError()
  const fail = (reason: string, detectedDb: number | null = null): SystemAudioTestResult => ({
    ok: false,
    detectedDb,
    reason,
  })

  const source = new LoopbackSource()
  let stream: MediaStream
  try {
    stream = await source.start()
  } catch {
    return fail(SYSTEM_AUDIO_TEST_REASONS.loopbackUnavailable)
  }

  const capacity = Math.ceil(
    ((BASELINE_MS + TONE_SECONDS * 1000 + TAIL_MS + 2000) / 1000) * VAD_SAMPLE_RATE,
  )
  const captured = new Float32Array(capacity)
  let filled = 0
  let recording = false
  let gotFrame: () => void = () => undefined
  const firstFrame = new Promise<void>((resolve) => {
    gotFrame = resolve
  })

  let graph: CaptureGraph | null = null
  try {
    try {
      graph = await openCaptureGraph(stream, {
        onFrame(frame) {
          gotFrame()
          if (!recording || filled + frame.length > captured.length) return
          captured.set(frame, filled)
          filled += frame.length
        },
      })
    } catch {
      return fail(SYSTEM_AUDIO_TEST_REASONS.loopbackUnavailable)
    }
    let timer: ReturnType<typeof setTimeout> | null = null
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), FIRST_FRAME_TIMEOUT_MS)
    })
    const arrived = await Promise.race([firstFrame.then(() => true), timedOut])
    if (timer) clearTimeout(timer)
    if (signal?.aborted) throw abortError()
    if (!arrived) return fail(SYSTEM_AUDIO_TEST_REASONS.noAudio)

    recording = true
    await sleep(BASELINE_MS, signal)
    const baselineSamples = filled
    try {
      await playTestTone(signal)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err
      return fail(SYSTEM_AUDIO_TEST_REASONS.playbackFailed)
    }
    await sleep(TAIL_MS, signal)
    recording = false

    const result = analyzeToneCapture(captured.subarray(0, filled), baselineSamples)
    const detectedDb = Math.round(result.detectedDb * 10) / 10
    if (result.ok) return { ok: true, detectedDb, reason: null }
    return result.detectedDb >= MIN_TONE_DBFS
      ? fail(SYSTEM_AUDIO_TEST_REASONS.tooQuiet, detectedDb)
      : fail(SYSTEM_AUDIO_TEST_REASONS.notDetected, null)
  } finally {
    source.stop()
    await graph?.close()
  }
}
