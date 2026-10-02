import { describe, expect, it } from 'vitest'
import {
  encodeWavPcm16,
  levelToMeter,
  peakWindowRms,
  rms,
  rmsToDb,
} from '@renderer/settings/lib/wav'

function ascii(bytes: Uint8Array, start: number, len: number): string {
  return String.fromCharCode(...bytes.slice(start, start + len))
}

describe('encodeWavPcm16', () => {
  it('writes a 16 kHz mono PCM16 RIFF header', () => {
    const wav = encodeWavPcm16(new Float32Array(16000), 16000)
    const view = new DataView(wav.buffer)
    expect(wav.byteLength).toBe(44 + 32000)
    expect(ascii(wav, 0, 4)).toBe('RIFF')
    expect(view.getUint32(4, true)).toBe(36 + 32000)
    expect(ascii(wav, 8, 4)).toBe('WAVE')
    expect(ascii(wav, 12, 4)).toBe('fmt ')
    expect(view.getUint16(20, true)).toBe(1) // PCM
    expect(view.getUint16(22, true)).toBe(1) // mono
    expect(view.getUint32(24, true)).toBe(16000)
    expect(view.getUint32(28, true)).toBe(32000)
    expect(view.getUint16(34, true)).toBe(16)
    expect(ascii(wav, 36, 4)).toBe('data')
    expect(view.getUint32(40, true)).toBe(32000)
  })

  it('encodes and clips samples', () => {
    const wav = encodeWavPcm16(new Float32Array([0, 1, -1, 0.5, 2, -3]), 16000)
    const view = new DataView(wav.buffer)
    const samples = Array.from({ length: 6 }, (_, i) => view.getInt16(44 + i * 2, true))
    expect(samples).toEqual([0, 32767, -32768, 16384, 32767, -32768])
  })
})

describe('levels', () => {
  it('computes RMS and the loudest window', () => {
    expect(rms([])).toBe(0)
    expect(rms([0.5, -0.5, 0.5, -0.5])).toBeCloseTo(0.5)
    const quietThenLoud = new Float32Array(1600)
    quietThenLoud.fill(0.01, 0, 800)
    quietThenLoud.fill(0.4, 800)
    expect(peakWindowRms(quietThenLoud)).toBeCloseTo(0.4)
  })

  it('maps RMS to dB and a perceptual meter position', () => {
    expect(rmsToDb(1)).toBe(0)
    expect(rmsToDb(0.1)).toBeCloseTo(-20)
    expect(rmsToDb(0)).toBe(-100)
    expect(levelToMeter(0)).toBe(0)
    expect(levelToMeter(1)).toBe(1)
    expect(levelToMeter(0.01)).toBeCloseTo(0.4) // -40 dBFS
  })
})
