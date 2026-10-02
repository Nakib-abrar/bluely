/**
 * Seam between the Settings / Onboarding audio tests and the audio capture code.
 *
 * These are small self-contained implementations so the settings UI works on its own; the
 * integrator may replace the bodies with re-exports from '../audio/*' (same signatures).
 * Errors from getUserMedia are left as DOMExceptions (NotAllowedError, NotFoundError, …) so the
 * UI can explain them; aborts reject with a DOMException named 'AbortError'.
 */
import { t } from '@shared/i18n'
import { AUDIO } from '@shared/constants'
import { invoke } from '../lib/ipc'
import { encodeWavPcm16, peakWindowRms, rms, rmsToDb } from './lib/wav'

const LEVEL_INTERVAL_MS = 50
/** Below this RMS (about -50 dBFS) the system-audio test counts as silence. */
const SYSTEM_AUDIO_MIN_RMS = 0.003
const SYSTEM_AUDIO_LISTEN_MS = 3000

function abortError(): DOMException {
  return new DOMException('Aborted', 'AbortError')
}

function micConstraints(deviceId: string | null): MediaStreamConstraints {
  return {
    audio: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  }
}

/** Polls an AnalyserNode and reports the RMS of each block. Returns a stop function. */
function pollLevels(analyser: AnalyserNode, onLevel: (value: number) => void): () => void {
  const block = new Float32Array(analyser.fftSize)
  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(block)
    onLevel(rms(block))
  }, LEVEL_INTERVAL_MS)
  return () => clearInterval(timer)
}

function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop()
}

/** Audio input devices. "System default" is represented by `null` in settings, so aliases are dropped. */
export async function listMicrophones(): Promise<{ deviceId: string; label: string }[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return []
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices
    .filter((d) => d.kind === 'audioinput')
    .filter((d) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
    .map((d, i) => ({
      deviceId: d.deviceId,
      label: d.label || t('settings.audio.mic.unnamed', { n: i + 1 }),
    }))
}

export interface MicSampleResult {
  wav: Uint8Array
  durationMs: number
  peakRms: number
}

function pickRecorderMime(): string | undefined {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
  return candidates.find((m) => MediaRecorder.isTypeSupported(m))
}

/** Downmixes and resamples decoded audio to 16 kHz mono (the format the STT pipeline expects). */
async function toSpeechPcm(buffer: AudioBuffer): Promise<Float32Array> {
  const length = Math.max(1, Math.ceil(buffer.duration * AUDIO.sampleRate))
  const offline = new OfflineAudioContext(1, length, AUDIO.sampleRate)
  const source = offline.createBufferSource()
  source.buffer = buffer
  source.connect(offline.destination)
  source.start()
  const rendered = await offline.startRendering()
  return rendered.getChannelData(0)
}

/**
 * Records `seconds` of microphone audio and returns it as a 16 kHz mono PCM16 WAV.
 * MediaRecorder captures (no ScriptProcessor/AudioWorklet needed), then the clip is decoded and
 * resampled with an OfflineAudioContext.
 */
export async function recordMicSample(opts: {
  deviceId: string | null
  seconds: number
  onLevel?: (rms: number) => void
  signal?: AbortSignal
}): Promise<MicSampleResult> {
  const { deviceId, seconds, onLevel, signal } = opts
  if (signal?.aborted) throw abortError()
  const stream = await navigator.mediaDevices.getUserMedia(micConstraints(deviceId))
  const ctx = new AudioContext()
  let stopPolling: () => void = () => undefined
  try {
    if (signal?.aborted) throw abortError()
    await ctx.resume()
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 2048
    ctx.createMediaStreamSource(stream).connect(analyser)
    let livePeak = 0
    stopPolling = pollLevels(analyser, (value) => {
      livePeak = Math.max(livePeak, value)
      onLevel?.(value)
    })

    const mimeType = pickRecorderMime()
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
    const chunks: Blob[] = []
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data)
    }
    const startedAt = performance.now()
    await new Promise<void>((resolve, reject) => {
      const stop = () => {
        if (recorder.state !== 'inactive') recorder.stop()
      }
      const timer = setTimeout(stop, Math.max(0.5, seconds) * 1000)
      const onAbort = () => {
        clearTimeout(timer)
        stop()
        reject(abortError())
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      recorder.onstop = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }
      recorder.onerror = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        reject(new Error(t('settings.audio.mic.recordFailed')))
      }
      recorder.start(250)
    })
    const durationMs = Math.round(performance.now() - startedAt)
    stopPolling()
    const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' })
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer())
    const pcm = await toSpeechPcm(decoded)
    return {
      wav: encodeWavPcm16(pcm, AUDIO.sampleRate),
      durationMs,
      peakRms: Math.max(livePeak, peakWindowRms(pcm)),
    }
  } finally {
    stopPolling()
    stopStream(stream)
    void ctx.close().catch(() => undefined)
  }
}

/** Transcribes a test clip with the configured speech-to-text model (main process). */
export async function transcribeSample(
  wav: Uint8Array,
): Promise<{ text: string; latencyMs: number; model: string }> {
  return invoke('audio:testTranscribe', { wav })
}

/** Live input level for a microphone. Resolves to a stop function once the mic is open. */
export async function startLevelMeter(
  deviceId: string | null,
  onLevel: (rms: number) => void,
): Promise<() => void> {
  const stream = await navigator.mediaDevices.getUserMedia(micConstraints(deviceId))
  const ctx = new AudioContext()
  await ctx.resume().catch(() => undefined)
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 1024
  ctx.createMediaStreamSource(stream).connect(analyser)
  const stopPolling = pollLevels(analyser, onLevel)
  return () => {
    stopPolling()
    stopStream(stream)
    void ctx.close().catch(() => undefined)
  }
}

export interface SystemAudioTestResult {
  ok: boolean
  detectedDb: number | null
  reason: string | null
}

/**
 * Listens to the desktop loopback audio (the "Them" channel) for a few seconds and reports whether
 * any sound was heard. The main process answers getDisplayMedia with loopback audio, no picker.
 */
export async function testSystemAudio(
  opts: { signal?: AbortSignal } = {},
): Promise<SystemAudioTestResult> {
  const { signal } = opts
  if (signal?.aborted) throw abortError()
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })
  } catch {
    return { ok: false, detectedDb: null, reason: t('settings.audio.system.unavailable') }
  }
  const track = stream.getAudioTracks()[0]
  if (!track) {
    stopStream(stream)
    return { ok: false, detectedDb: null, reason: t('settings.audio.system.noTrack') }
  }
  const ctx = new AudioContext()
  let stopPolling: () => void = () => undefined
  try {
    await ctx.resume().catch(() => undefined)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 2048
    ctx.createMediaStreamSource(new MediaStream([track])).connect(analyser)
    let peak = 0
    stopPolling = pollLevels(analyser, (value) => {
      peak = Math.max(peak, value)
    })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, SYSTEM_AUDIO_LISTEN_MS)
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          reject(abortError())
        },
        { once: true },
      )
    })
    const detectedDb = Math.round(rmsToDb(peak))
    if (peak < SYSTEM_AUDIO_MIN_RMS) {
      return { ok: false, detectedDb, reason: t('settings.audio.system.silent') }
    }
    return { ok: true, detectedDb, reason: null }
  } finally {
    stopPolling()
    stopStream(stream)
    void ctx.close().catch(() => undefined)
  }
}
