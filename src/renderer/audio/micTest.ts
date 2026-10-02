/**
 * Settings › Audio helpers: microphone list, live level meter and "Test microphone"
 * (record a short sample through the same capture path as live sessions, then transcribe it
 * with the configured STT model in main).
 */
import { invoke } from '@renderer/lib/ipc'
import { openCaptureGraph, type CaptureGraph } from './captureGraph'
import { FRAME_SAMPLES, VAD_SAMPLE_RATE } from './segmenter'
import { MicSource } from './sources'
import { encodeWav16 } from './wav'

export interface MicrophoneInfo {
  deviceId: string
  label: string
}

/** Chromium's pseudo-devices; `micDeviceId: null` already means "system default". */
const PSEUDO_DEVICE_IDS = new Set(['default', 'communications'])

/**
 * Audio input devices. Labels are hidden until microphone permission has been granted in
 * this page, so when every label is empty a throwaway stream is opened once to unlock them.
 * Fallback labels ("Microphone 2") are English; the UI may substitute its own.
 */
export async function listMicrophones(): Promise<MicrophoneInfo[]> {
  const md = navigator.mediaDevices
  let inputs = (await md.enumerateDevices()).filter((d) => d.kind === 'audioinput')
  if (inputs.length > 0 && inputs.every((d) => !d.label)) {
    try {
      const stream = await md.getUserMedia({ audio: true, video: false })
      for (const track of stream.getTracks()) track.stop()
      inputs = (await md.enumerateDevices()).filter((d) => d.kind === 'audioinput')
    } catch {
      // Permission denied or no device: return what we have (unlabelled).
    }
  }
  const real = inputs.filter((d) => !PSEUDO_DEVICE_IDS.has(d.deviceId))
  const chosen = real.length > 0 ? real : inputs
  const seen = new Set<string>()
  const result: MicrophoneInfo[] = []
  for (const device of chosen) {
    if (!device.deviceId || seen.has(device.deviceId)) continue
    seen.add(device.deviceId)
    result.push({
      deviceId: device.deviceId,
      label: device.label || `Microphone ${result.length + 1}`,
    })
  }
  return result
}

export interface MicSampleResult {
  /** 16 kHz mono 16-bit PCM WAV. */
  wav: Uint8Array
  durationMs: number
  /** Loudest 32 ms frame RMS (linear); near 0 means the mic captured silence. */
  peakRms: number
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted', 'AbortError')
}

/**
 * Records `seconds` (1–30) of microphone audio, resampled to 16 kHz exactly as in a live
 * session (same constraints, worklet and resampler). `onLevel` receives each frame's RMS
 * (~31 Hz) for a meter. Rejects with AudioSourceError when the mic cannot be opened and with
 * an AbortError DOMException when `signal` aborts.
 */
export async function recordMicSample(opts: {
  deviceId: string | null
  seconds: number
  onLevel?: (rms: number) => void
  signal?: AbortSignal
}): Promise<MicSampleResult> {
  const { signal, onLevel } = opts
  if (signal?.aborted) throw abortError()
  const seconds = Math.min(30, Math.max(1, Number.isFinite(opts.seconds) ? opts.seconds : 5))
  const targetSamples = Math.round(seconds * VAD_SAMPLE_RATE)
  const samples = new Float32Array(Math.ceil(targetSamples / FRAME_SAMPLES) * FRAME_SAMPLES)
  let filled = 0
  let peakRms = 0

  const source = new MicSource(opts.deviceId)
  // Mutated from callbacks, so kept in an object (no stale narrowing, no leak on early exit).
  const state: { graph: CaptureGraph | null; done: boolean } = { graph: null, done: false }
  const onAbort = { fn: null as (() => void) | null }
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    const stream = await source.start()
    if (signal?.aborted) throw abortError()
    await new Promise<void>((resolve, reject) => {
      onAbort.fn = () => reject(abortError())
      signal?.addEventListener('abort', onAbort.fn, { once: true })
      // Frames normally arrive in real time; this only catches a stalled audio device.
      timer = setTimeout(
        () => reject(new Error('The microphone stopped delivering audio')),
        seconds * 1000 + 5000,
      )
      openCaptureGraph(stream, {
        onFrame(frame, rms) {
          if (filled >= targetSamples) return
          samples.set(frame, filled)
          filled += frame.length
          if (rms > peakRms) peakRms = rms
          onLevel?.(rms)
          if (filled >= targetSamples) resolve()
        },
      }).then((g) => {
        if (state.done) void g.close()
        else state.graph = g
      }, reject)
    })
  } finally {
    state.done = true
    if (timer) clearTimeout(timer)
    if (onAbort.fn) signal?.removeEventListener('abort', onAbort.fn)
    source.stop()
    await state.graph?.close()
  }
  const recorded = samples.subarray(0, Math.min(filled, targetSamples))
  return {
    wav: encodeWav16(recorded),
    durationMs: (recorded.length / VAD_SAMPLE_RATE) * 1000,
    peakRms,
  }
}

/** Sends a recorded sample to main for transcription with the configured STT model. */
export function transcribeSample(
  wav: Uint8Array,
): Promise<{ text: string; latencyMs: number; model: string }> {
  return invoke('audio:testTranscribe', { wav })
}

/**
 * Live input meter for the microphone picker: calls `onLevel(rms)` for every 32 ms frame.
 * Resolves with a stop function once the device is open (rejects with AudioSourceError).
 */
export async function startLevelMeter(
  deviceId: string | null,
  onLevel: (rms: number) => void,
): Promise<() => void> {
  const source = new MicSource(deviceId)
  const stream = await source.start()
  let stopped = false
  let graph: CaptureGraph
  try {
    graph = await openCaptureGraph(stream, {
      onFrame(_frame, rms) {
        if (!stopped) onLevel(rms)
      },
    })
  } catch (err) {
    source.stop()
    throw err
  }
  return () => {
    if (stopped) return
    stopped = true
    source.stop()
    void graph.close()
  }
}
