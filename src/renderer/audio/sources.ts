/**
 * Where capture audio comes from. Both channels hand the pipeline a MediaStream:
 * - Me   = MicSource: the selected microphone (Chromium AEC/NS/AGC on).
 * - Them = LoopbackSource: Windows desktop loopback via getDisplayMedia; main's
 *   setDisplayMediaRequestHandler answers with the primary screen + `audio: 'loopback'`.
 */

export type AudioSourceKind = 'mic' | 'loopback' | 'sidecar'

export type AudioSourceErrorCode =
  'mic_not_found' | 'mic_denied' | 'mic_muted' | 'loopback_unavailable' | 'unknown'

/** Typed capture failure; `code` drives channel status + session warnings. */
export class AudioSourceError extends Error {
  readonly code: AudioSourceErrorCode

  constructor(code: AudioSourceErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'AudioSourceError'
    this.code = code
  }
}

/** Something that can produce a live audio MediaStream for one channel. */
export interface AudioSource {
  readonly kind: AudioSourceKind
  /** Opens the device. Rejects with AudioSourceError. */
  start(): Promise<MediaStream>
  /** Stops every track. Safe to call more than once. */
  stop(): void
}

function errorName(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'name' in err) {
    const name = (err as { name: unknown }).name
    if (typeof name === 'string') return name
  }
  return ''
}

function errorText(err: unknown): string {
  if (err instanceof Error && err.message) return err.message
  return String(err)
}

/**
 * Maps getUserMedia/getDisplayMedia DOMExceptions to AudioSourceError codes.
 * Mic: NotFound/Overconstrained → mic_not_found (device unplugged or the saved deviceId is
 * gone), NotAllowed/Security → mic_denied (Windows privacy settings or permission handler),
 * anything else (e.g. NotReadableError: device busy/driver error) → unknown.
 * Loopback: every failure means desktop audio is unavailable.
 */
export function toAudioSourceError(err: unknown, kind: AudioSourceKind): AudioSourceError {
  if (err instanceof AudioSourceError) return err
  const name = errorName(err)
  const detail = errorText(err)
  if (kind === 'loopback' || kind === 'sidecar') {
    return new AudioSourceError(
      'loopback_unavailable',
      `System audio capture failed (${name || 'Error'}): ${detail}`,
      { cause: err },
    )
  }
  switch (name) {
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return new AudioSourceError('mic_not_found', `Microphone not found: ${detail}`, {
        cause: err,
      })
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return new AudioSourceError('mic_denied', `Microphone access was denied: ${detail}`, {
        cause: err,
      })
    default:
      return new AudioSourceError(
        'unknown',
        `Could not open the microphone (${name || 'Error'}): ${detail}`,
        { cause: err },
      )
  }
}

function stopTracks(stream: MediaStream | null): void {
  if (!stream) return
  for (const track of stream.getTracks()) {
    try {
      track.stop()
    } catch {
      // Already stopped.
    }
  }
}

/** Builds the getUserMedia constraints for a microphone (exported for tests). */
export function micConstraints(deviceId: string | null): MediaStreamConstraints {
  const audio: MediaTrackConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  }
  if (deviceId) audio.deviceId = { exact: deviceId }
  return { audio, video: false }
}

/** The "Me" channel: a microphone, `deviceId` null = the system default device. */
export class MicSource implements AudioSource {
  readonly kind = 'mic' as const
  private stream: MediaStream | null = null

  constructor(readonly deviceId: string | null) {}

  async start(): Promise<MediaStream> {
    this.stop()
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia(micConstraints(this.deviceId))
    } catch (err) {
      throw toAudioSourceError(err, 'mic')
    }
    if (stream.getAudioTracks().length === 0) {
      stopTracks(stream)
      throw new AudioSourceError('mic_not_found', 'The microphone stream has no audio track')
    }
    this.stream = stream
    return stream
  }

  stop(): void {
    stopTracks(this.stream)
    this.stream = null
  }
}

/**
 * getDisplayMedia constraints for the loopback (exported for tests). Voice processing must be
 * off: with Electron's display-media handler Chromium otherwise treats the loopback like a
 * microphone and enables AEC/NS/AGC on it (verified: getSettings() reported all three true).
 * Echo cancellation would try to remove the very audio we want (the call's far end), noise
 * suppression degrades it and AGC fights the user's volume; Them should be captured raw.
 */
export const LOOPBACK_CONSTRAINTS: DisplayMediaStreamOptions = {
  video: true,
  audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
}

/**
 * Belt and braces: if a Chromium version ignores the getDisplayMedia audio constraints, turn
 * the processing off on the track itself. Failure is not fatal (capture still works).
 */
export async function ensureNoVoiceProcessing(track: MediaStreamTrack): Promise<void> {
  const settings = track.getSettings?.() ?? {}
  const processed =
    settings.echoCancellation === true ||
    settings.noiseSuppression === true ||
    settings.autoGainControl === true
  if (!processed) return
  try {
    await track.applyConstraints({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    })
  } catch {
    // Keep the (processed) track rather than losing the Them channel.
  }
}

/**
 * The "Them" channel: desktop (loopback) audio. getDisplayMedia requires video, so the
 * screen track main hands back is stopped and removed immediately; only audio is kept.
 */
export class LoopbackSource implements AudioSource {
  readonly kind = 'loopback' as const
  private stream: MediaStream | null = null

  async start(): Promise<MediaStream> {
    this.stop()
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getDisplayMedia(LOOPBACK_CONSTRAINTS)
    } catch (err) {
      throw toAudioSourceError(err, 'loopback')
    }
    for (const track of stream.getVideoTracks()) {
      track.stop()
      stream.removeTrack(track)
    }
    if (stream.getAudioTracks().length === 0) {
      stopTracks(stream)
      throw new AudioSourceError(
        'loopback_unavailable',
        'System audio is not available: the capture returned no audio track',
      )
    }
    for (const track of stream.getAudioTracks()) await ensureNoVoiceProcessing(track)
    this.stream = stream
    return stream
  }

  stop(): void {
    stopTracks(this.stream)
    this.stream = null
  }
}

/*
 * Future: SidecarSource (kind 'sidecar').
 *
 * If Electron's loopback path breaks on some Windows setups, main would spawn a small WASAPI
 * loopback helper that writes 16 kHz mono s16le PCM to stdout. Main forwards chunks to this
 * renderer over a MessagePort (transferred ArrayBuffers; never through the invoke envelope).
 * SidecarSource.start() would then build a MediaStream from them with
 * `new MediaStreamTrackGenerator({ kind: 'audio' })` (Chromium "breakout box"), writing
 * `AudioData` objects to `generator.writable`, and return `new MediaStream([generator])`.
 * Everything downstream (worklet, resampler passthrough at 16 kHz, VAD, segments) stays the
 * same, which is why the pipeline only depends on the AudioSource interface. stop() would ask
 * main to kill the helper and close the generator. Errors map to 'loopback_unavailable'.
 */
