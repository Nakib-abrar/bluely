/**
 * WAV (RIFF PCM) encoding for speech segments sent to main for transcription. Pure.
 */

export const WAV_HEADER_BYTES = 44

/**
 * Encodes mono float samples as 16-bit little-endian PCM WAV with the canonical 44-byte
 * header. Samples are clamped to [-1, 1]; NaN becomes silence.
 */
export function encodeWav16(samples: Float32Array, sampleRate = 16_000): Uint8Array {
  if (!(sampleRate > 0) || !Number.isInteger(sampleRate)) {
    throw new RangeError(`Invalid WAV sample rate: ${sampleRate}`)
  }
  const dataBytes = samples.length * 2
  const bytes = new Uint8Array(WAV_HEADER_BYTES + dataBytes)
  const view = new DataView(bytes.buffer)
  writeAscii(bytes, 0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeAscii(bytes, 8, 'WAVE')
  writeAscii(bytes, 12, 'fmt ')
  view.setUint32(16, 16, true) // fmt chunk size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  writeAscii(bytes, 36, 'data')
  view.setUint32(40, dataBytes, true)

  let offset = WAV_HEADER_BYTES
  for (let i = 0; i < samples.length; i++) {
    let s = samples[i] as number
    if (Number.isNaN(s)) s = 0
    else if (s > 1) s = 1
    else if (s < -1) s = -1
    // Asymmetric scaling maps -1 → -32768 and 1 → 32767 exactly.
    view.setInt16(offset, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true)
    offset += 2
  }
  return bytes
}

export interface DecodedWav {
  sampleRate: number
  channels: number
  /** Mono (channels averaged) samples in [-1, 1]. */
  samples: Float32Array
}

/**
 * Decodes a 16-bit PCM WAV (any channel count, unknown chunks skipped). Used by tests, the
 * dev harness and to validate fixtures; throws on anything else.
 */
export function decodeWav16(bytes: Uint8Array): DecodedWav {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.byteLength < 12 || readAscii(bytes, 0) !== 'RIFF' || readAscii(bytes, 8) !== 'WAVE') {
    throw new Error('Not a RIFF/WAVE file')
  }
  let offset = 12
  let sampleRate = 0
  let channels = 0
  let bits = 0
  let format = 0
  while (offset + 8 <= bytes.byteLength) {
    const id = readAscii(bytes, offset)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (id === 'fmt ') {
      format = view.getUint16(body, true)
      channels = view.getUint16(body + 2, true)
      sampleRate = view.getUint32(body + 4, true)
      bits = view.getUint16(body + 14, true)
    } else if (id === 'data') {
      if (format !== 1 || bits !== 16 || channels < 1) {
        throw new Error(`Unsupported WAV format (format ${format}, ${bits} bits)`)
      }
      const available = Math.min(size, bytes.byteLength - body)
      const frames = Math.floor(available / (2 * channels))
      const samples = new Float32Array(frames)
      for (let i = 0; i < frames; i++) {
        let sum = 0
        for (let c = 0; c < channels; c++) {
          sum += view.getInt16(body + (i * channels + c) * 2, true) / 0x8000
        }
        samples[i] = sum / channels
      }
      return { sampleRate, channels, samples }
    }
    offset = body + size + (size % 2) // chunks are word aligned
  }
  throw new Error('WAV has no data chunk')
}

function writeAscii(bytes: Uint8Array, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i)
}

function readAscii(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset] ?? 0,
    bytes[offset + 1] ?? 0,
    bytes[offset + 2] ?? 0,
    bytes[offset + 3] ?? 0,
  )
}
