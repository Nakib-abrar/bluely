/**
 * Pure audio helpers for the Settings audio tests (no DOM / Web Audio here so they are unit-testable).
 */

/** Encodes mono float samples (-1..1) as a 16-bit PCM WAV file. Out-of-range samples are clipped. */
export function encodeWavPcm16(samples: Float32Array, sampleRate: number): Uint8Array {
  const dataBytes = samples.length * 2
  const buffer = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buffer)
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }
  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true) // fmt chunk size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  writeAscii(36, 'data')
  view.setUint32(40, dataBytes, true)
  let offset = 44
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0))
    view.setInt16(offset, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true)
    offset += 2
  }
  return new Uint8Array(buffer)
}

/** Root-mean-square level of a block of samples (0..1). */
export function rms(samples: ArrayLike<number>, start = 0, end = samples.length): number {
  const n = end - start
  if (n <= 0) return 0
  let sum = 0
  for (let i = start; i < end; i++) {
    const v = samples[i] ?? 0
    sum += v * v
  }
  return Math.sqrt(sum / n)
}

/** Highest RMS over consecutive windows (default 50 ms at 16 kHz), i.e. "how loud was the loudest bit". */
export function peakWindowRms(samples: ArrayLike<number>, windowSize = 800): number {
  let peak = 0
  for (let start = 0; start < samples.length; start += windowSize) {
    peak = Math.max(peak, rms(samples, start, Math.min(samples.length, start + windowSize)))
  }
  return peak
}

/** RMS (0..1) → dBFS, clamped to -100 for silence. */
export function rmsToDb(value: number): number {
  if (value <= 0) return -100
  return Math.max(-100, 20 * Math.log10(value))
}

/**
 * Maps an RMS level to a 0..1 meter position on a perceptual (dB) scale so quiet speech still
 * moves the bar: -60 dBFS → 0, -10 dBFS → 1.
 */
export function levelToMeter(value: number): number {
  const db = rmsToDb(value)
  return Math.max(0, Math.min(1, (db + 60) / 50))
}
