/**
 * Dev-only audio harness page (built only with BLUELY_HARNESS=1, never shipped). Exposes
 * `window.__bluelyHarness` so Playwright can drive the real capture pipeline inside
 * Electron with Chromium's fake media devices or a PulseAudio null sink.
 */
import type { Channel, ChannelState } from '@shared/types'
import { IpcError, invoke } from '@renderer/lib/ipc'
import { CaptureController, type CaptureSink } from '../audio/captureController'
import { openCaptureGraph } from '../audio/captureGraph'
import { listMicrophones, recordMicSample } from '../audio/micTest'
import { LoopbackSource, MicSource } from '../audio/sources'
import { testSystemAudio } from '../audio/systemAudioTest'
import { createSileroVad } from '../audio/vad'
import { decodeWav16, encodeWav16 } from '../audio/wav'
import type {
  BluelyHarness,
  HarnessCaptureResult,
  HarnessFrameStats,
  HarnessSegment,
} from './types'

const statusEl = document.getElementById('status')
function setStatus(text: string): void {
  if (statusEl) statusEl.textContent = text
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function describeWav(wav: Uint8Array): { valid: boolean; audioMs: number; peak: number } {
  try {
    const decoded = decodeWav16(wav)
    let peak = 0
    for (const s of decoded.samples) peak = Math.max(peak, Math.abs(s))
    const valid =
      decoded.sampleRate === 16_000 &&
      decoded.channels === 1 &&
      wav.byteLength === 44 + decoded.samples.length * 2
    return { valid, audioMs: (decoded.samples.length / 16_000) * 1000, peak }
  } catch {
    return { valid: false, audioMs: 0, peak: 0 }
  }
}

async function runCapture(seconds: number): Promise<HarnessCaptureResult> {
  const result: HarnessCaptureResult = {
    segments: [],
    allSegments: [],
    statuses: [],
    warnings: [],
    stoppedCalls: 0,
    snapshots: 0,
    elapsedMs: 0,
    callOrder: [],
  }
  const sink: CaptureSink = {
    async segment(req) {
      result.callOrder.push('segment')
      const info = describeWav(req.wav)
      const seg: HarnessSegment = {
        channel: req.channel as Channel,
        startedAt: req.startedAt,
        endedAt: req.endedAt,
        vadEndAt: req.vadEndAt,
        forced: req.forced,
        durationMs: req.endedAt - req.startedAt,
        audioMs: info.audioMs,
        wavBytes: req.wav.byteLength,
        wavValid: info.valid,
        peak: info.peak,
      }
      result.allSegments.push(seg)
      if (seg.channel === 'me') result.segments.push(seg)
      return { accepted: true }
    },
    async channelStatus(req) {
      result.callOrder.push(`status:${req.channel}:${req.state}`)
      result.statuses.push({
        channel: req.channel as Channel,
        state: req.state as ChannelState,
        error: req.error ?? null,
      })
    },
    async warning(req) {
      result.callOrder.push(`warning:${req.code}:${req.active}`)
      result.warnings.push({ code: req.code, active: req.active })
    },
    async stopped() {
      result.callOrder.push('stopped')
      result.stoppedCalls++
    },
    log(level, message) {
      if (level === 'warn' || level === 'error') console.warn(`[harness:audio] ${message}`)
    },
  }
  const controller = new CaptureController({ sink })
  const unsubscribe = controller.subscribe(() => {
    result.snapshots++
  })
  setStatus(`capturing for ${seconds}s`)
  const started = performance.now()
  await controller.start({
    sessionId: 'harness',
    micDeviceId: null,
    sensitivity: 0.5,
    maxSegmentSec: 12,
  })
  await sleep(seconds * 1000)
  await controller.stop()
  result.elapsedMs = performance.now() - started
  unsubscribe()
  setStatus(`done: ${result.allSegments.length} segments`)
  return result
}

/** AudioContext.sinkId is '' (default device), a device id, or an AudioSinkInfo object. */
function describeSink(sinkId: unknown): string {
  if (typeof sinkId === 'string') return sinkId === '' ? 'default' : `device:${sinkId}`
  if (sinkId && typeof sinkId === 'object' && 'type' in sinkId) {
    return String((sinkId as { type: unknown }).type)
  }
  return 'unknown'
}

async function measureFrames(seconds: number): Promise<HarnessFrameStats> {
  const source = new MicSource(null)
  const stream = await source.start()
  let frames = 0
  let rmsSum = 0
  let inputSampleRate: number | null = null
  let firstAt = 0
  let lastAt = 0
  const graph = await openCaptureGraph(stream, {
    onFrame(_frame, rms) {
      const now = performance.now()
      if (frames === 0) firstAt = now
      lastAt = now
      frames++
      rmsSum += rms
    },
    onStarted(info) {
      inputSampleRate = info.inputSampleRate
    },
  })
  await sleep(seconds * 1000)
  source.stop()
  await graph.close()
  const span = Math.max(0.001, (lastAt - firstAt) / 1000)
  return {
    frames,
    seconds: span,
    framesPerSecond: frames > 1 ? (frames - 1) / span : 0,
    contextSampleRate: graph.sampleRate,
    sink: describeSink((graph.context as unknown as { sinkId?: unknown }).sinkId),
    inputSampleRate,
    meanRms: frames ? rmsSum / frames : 0,
  }
}

function encodeWavSelfTest(): { ok: boolean; bytes: number; maxError: number } {
  const samples = new Float32Array(1600)
  for (let i = 0; i < samples.length; i++)
    samples[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / 16_000)
  const wav = encodeWav16(samples)
  const decoded = decodeWav16(wav)
  let maxError = 0
  for (let i = 0; i < samples.length; i++) {
    maxError = Math.max(maxError, Math.abs((decoded.samples[i] as number) - (samples[i] as number)))
  }
  const ok = wav.byteLength === 44 + 3200 && decoded.sampleRate === 16_000 && maxError < 1e-4
  return { ok, bytes: wav.byteLength, maxError }
}

async function ipcSegmentProbe(): Promise<{ valid: string; invalid: string }> {
  const code = async (wav: Uint8Array): Promise<string> => {
    const now = Date.now()
    try {
      await invoke('audio:segment', {
        sessionId: 'harness-probe',
        channel: 'me',
        startedAt: now - 100,
        endedAt: now,
        vadEndAt: now,
        forced: false,
        wav,
      })
      return 'ok'
    } catch (err) {
      return err instanceof IpcError ? err.code : 'error'
    }
  }
  return {
    valid: await code(encodeWav16(new Float32Array(1600))),
    invalid: await code(new Uint8Array(10)),
  }
}

/** Settings Chromium applied to each capture track (checks audio processing on loopback). */
async function trackSettings(): Promise<{
  mic: MediaTrackSettings | null
  loopback: MediaTrackSettings | null
  loopbackError: string | null
}> {
  const read = async (source: { start(): Promise<MediaStream>; stop(): void }) => {
    const stream = await source.start()
    const settings = stream.getAudioTracks()[0]?.getSettings() ?? null
    source.stop()
    return settings
  }
  const mic = await read(new MicSource(null))
  try {
    return { mic, loopback: await read(new LoopbackSource()), loopbackError: null }
  } catch (err) {
    return { mic, loopback: null, loopbackError: String(err) }
  }
}

async function vadBenchmark(frames: number): Promise<{ frames: number; msPerFrame: number }> {
  const vad = await createSileroVad({
    sensitivity: 0.5,
    maxSegmentMs: 12_000,
    onSpeechStart: () => undefined,
    onSpeechEnd: () => undefined,
  })
  const frame = new Float32Array(512)
  // Warm up (first inference compiles kernels).
  for (let i = 0; i < 5; i++) await vad.process(frame.slice())
  const started = performance.now()
  for (let i = 0; i < frames; i++) {
    for (let j = 0; j < frame.length; j++) frame[j] = (Math.random() - 0.5) * 0.02
    await vad.process(frame.slice())
  }
  const msPerFrame = (performance.now() - started) / frames
  await vad.dispose()
  return { frames, msPerFrame }
}

const harness: BluelyHarness = {
  runMicPipeline: runCapture,
  runCapture,
  measureFrames,
  testSystemAudio: () => testSystemAudio(),
  listMicrophones: () => listMicrophones(),
  async recordMicSample(seconds) {
    const r = await recordMicSample({ deviceId: null, seconds })
    return { durationMs: r.durationMs, peakRms: r.peakRms, wavBytes: r.wav.byteLength }
  },
  encodeWavSelfTest,
  ipcSegmentProbe,
  trackSettings,
  vadBenchmark,
}

window.__bluelyHarness = harness
setStatus('ready')
