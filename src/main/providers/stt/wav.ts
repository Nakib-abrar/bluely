import { AppError } from '../../errors'

/**
 * Minimal RIFF/WAVE inspection for the transcription path. Audio only ever lives in memory:
 * these helpers read the header and measure levels so near-silent segments can be skipped
 * before they cost an STT request.
 */

/** WAVE_FORMAT_PCM. */
export const WAV_FORMAT_PCM = 1
/** WAVE_FORMAT_IEEE_FLOAT. */
export const WAV_FORMAT_FLOAT = 3
const WAV_FORMAT_EXTENSIBLE = 0xfffe

/**
 * Below this RMS (≈ -48 dBFS) a segment is treated as silence. Applied to the loudest short
 * window, not the whole-segment mean, so one quiet word inside a long segment still counts.
 */
export const SILENCE_RMS_THRESHOLD = 0.004

export interface WavHeader {
  /** Effective sample format: 1 = integer PCM, 3 = IEEE float (extensible headers resolved). */
  audioFormat: number
  sampleRate: number
  channels: number
  bitsPerSample: number
  /** Byte offset of the first sample, relative to the start of the input. */
  dataOffset: number
  /** Bytes of sample data actually present (whole frames only). */
  dataBytes: number
  durationSec: number
}

export interface Pcm16Levels {
  /** Mean RMS over the whole segment, 0..1. */
  rms: number
  /** RMS of the loudest window (default 100 ms), 0..1. */
  peakWindowRms: number
}

function invalid(reason: string): AppError {
  return new AppError('invalid_audio', `Invalid WAV audio: ${reason}`)
}

function fourcc(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  )
}

/**
 * Parses a RIFF/WAVE header by walking its chunks (LIST/fact/… chunks before `data` are
 * skipped, so the data offset is not assumed to be 44). A data chunk that declares more bytes
 * than the buffer holds (truncated or streamed file) is clamped to what is present.
 * Throws AppError('invalid_audio') for anything that is not a usable PCM/float WAV.
 */
export function parseWavHeader(bytes: Uint8Array): WavHeader {
  if (!(bytes instanceof Uint8Array)) throw invalid('expected bytes')
  if (bytes.byteLength < 12) throw invalid('file is too short')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (fourcc(view, 0) !== 'RIFF' || fourcc(view, 8) !== 'WAVE') {
    throw invalid('not a RIFF/WAVE file')
  }

  let fmt: { audioFormat: number; channels: number; sampleRate: number; bits: number } | null = null
  let offset = 12
  while (offset + 8 <= bytes.byteLength) {
    const id = fourcc(view, offset)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > bytes.byteLength) throw invalid('truncated fmt chunk')
      let audioFormat = view.getUint16(body, true)
      const channels = view.getUint16(body + 2, true)
      const sampleRate = view.getUint32(body + 4, true)
      const bits = view.getUint16(body + 14, true)
      if (audioFormat === WAV_FORMAT_EXTENSIBLE) {
        // The real format is the first two bytes of the SubFormat GUID.
        if (size < 26 || body + 26 > bytes.byteLength) throw invalid('truncated extensible fmt')
        audioFormat = view.getUint16(body + 24, true)
      }
      fmt = { audioFormat, channels, sampleRate, bits }
      validateFormat(fmt)
    } else if (id === 'data') {
      if (!fmt) throw invalid('data chunk before fmt chunk')
      const blockAlign = fmt.channels * (fmt.bits / 8)
      const available = bytes.byteLength - body
      let dataBytes = size > available ? available : size
      dataBytes -= dataBytes % blockAlign
      return {
        audioFormat: fmt.audioFormat,
        sampleRate: fmt.sampleRate,
        channels: fmt.channels,
        bitsPerSample: fmt.bits,
        dataOffset: body,
        dataBytes,
        durationSec: dataBytes / (fmt.sampleRate * blockAlign),
      }
    }
    // Chunks are word aligned: odd sizes carry one pad byte.
    offset = body + size + (size & 1)
  }
  throw invalid(fmt ? 'missing data chunk' : 'missing fmt chunk')
}

function validateFormat(f: {
  audioFormat: number
  channels: number
  sampleRate: number
  bits: number
}) {
  if (f.audioFormat !== WAV_FORMAT_PCM && f.audioFormat !== WAV_FORMAT_FLOAT) {
    throw invalid(`unsupported sample format ${f.audioFormat}`)
  }
  if (f.channels < 1 || f.channels > 16) throw invalid(`bad channel count ${f.channels}`)
  if (f.sampleRate < 1000 || f.sampleRate > 384_000)
    throw invalid(`bad sample rate ${f.sampleRate}`)
  const okBits =
    f.audioFormat === WAV_FORMAT_FLOAT
      ? f.bits === 32 || f.bits === 64
      : [8, 16, 24, 32].includes(f.bits)
  if (!okBits) throw invalid(`bad bits per sample ${f.bits}`)
}

/** True when the header describes 16-bit integer PCM (what Bluely's capture produces). */
export function isPcm16(header: WavHeader): boolean {
  return header.audioFormat === WAV_FORMAT_PCM && header.bitsPerSample === 16
}

/**
 * Mean RMS plus the RMS of the loudest `windowMs` window, both normalised to 0..1.
 * Requires 16-bit PCM (throws AppError('invalid_audio') otherwise).
 */
export function pcm16Levels(bytes: Uint8Array, header: WavHeader, windowMs = 100): Pcm16Levels {
  if (!isPcm16(header)) throw invalid('expected 16-bit PCM')
  const samples = header.dataBytes >> 1
  if (samples === 0) return { rms: 0, peakWindowRms: 0 }
  const view = new DataView(bytes.buffer, bytes.byteOffset + header.dataOffset, samples * 2)
  const windowSamples = Math.max(
    1,
    Math.round((header.sampleRate * header.channels * windowMs) / 1000),
  )
  let total = 0
  let win = 0
  let winCount = 0
  let peakWinMeanSq = 0
  let sawFullWindow = false
  for (let i = 0; i < samples; i++) {
    const s = view.getInt16(i * 2, true) / 32768
    const sq = s * s
    total += sq
    win += sq
    if (++winCount === windowSamples) {
      peakWinMeanSq = Math.max(peakWinMeanSq, win / winCount)
      sawFullWindow = true
      win = 0
      winCount = 0
    }
  }
  // A trailing partial window counts when it is substantial or the clip is shorter than one.
  if (winCount > 0 && (!sawFullWindow || winCount * 2 >= windowSamples)) {
    peakWinMeanSq = Math.max(peakWinMeanSq, win / winCount)
  }
  return { rms: Math.sqrt(total / samples), peakWindowRms: Math.sqrt(peakWinMeanSq) }
}

/** Mean RMS (0..1) of 16-bit PCM sample data. */
export function pcm16Rms(bytes: Uint8Array, header: WavHeader): number {
  return pcm16Levels(bytes, header).rms
}

/**
 * True when no 100 ms window of the clip reaches `threshold` RMS. Conservative by design:
 * dropping a real (quiet) utterance is worse than paying for one silent request, and
 * formats other than 16-bit PCM are never reported silent. Throws on invalid WAV data.
 */
export function isLikelySilent(bytes: Uint8Array, threshold = SILENCE_RMS_THRESHOLD): boolean {
  const header = parseWavHeader(bytes)
  if (!isPcm16(header)) return false
  return pcm16Levels(bytes, header).peakWindowRms < threshold
}
