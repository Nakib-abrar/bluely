import { describe, expect, it } from 'vitest'
import { WAV_HEADER_BYTES, decodeWav16, encodeWav16 } from '@renderer/audio/wav'
import { fixture, sine } from './helpers'

const ascii = (bytes: Uint8Array, offset: number) =>
  String.fromCharCode(...bytes.subarray(offset, offset + 4))

describe('encodeWav16', () => {
  it('writes the canonical 44-byte PCM16 mono header', () => {
    const wav = encodeWav16(new Float32Array(10), 16_000)
    const view = new DataView(wav.buffer)
    expect(WAV_HEADER_BYTES).toBe(44)
    expect(wav.byteLength).toBe(44 + 20)
    expect(ascii(wav, 0)).toBe('RIFF')
    expect(view.getUint32(4, true)).toBe(36 + 20)
    expect(ascii(wav, 8)).toBe('WAVE')
    expect(ascii(wav, 12)).toBe('fmt ')
    expect(view.getUint32(16, true)).toBe(16)
    expect(view.getUint16(20, true)).toBe(1) // PCM
    expect(view.getUint16(22, true)).toBe(1) // mono
    expect(view.getUint32(24, true)).toBe(16_000)
    expect(view.getUint32(28, true)).toBe(32_000) // byte rate
    expect(view.getUint16(32, true)).toBe(2) // block align
    expect(view.getUint16(34, true)).toBe(16) // bits
    expect(ascii(wav, 36)).toBe('data')
    expect(view.getUint32(40, true)).toBe(20)
  })

  it('matches a known byte sequence', () => {
    const wav = encodeWav16(new Float32Array([0, 1, -1]), 8000)
    expect(Array.from(wav)).toEqual([
      0x52, 0x49, 0x46, 0x46, 0x2a, 0, 0, 0, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20, 16, 0,
      0, 0, 1, 0, 1, 0, 0x40, 0x1f, 0, 0, 0x80, 0x3e, 0, 0, 2, 0, 16, 0, 0x64, 0x61, 0x74, 0x61, 6,
      0, 0, 0, 0, 0, 0xff, 0x7f, 0x00, 0x80,
    ])
  })

  it('scales, rounds and clamps samples (little endian)', () => {
    const wav = encodeWav16(new Float32Array([0.5, -0.5, 2, -2, Number.NaN, 1e-6]))
    const view = new DataView(wav.buffer)
    const s = (i: number) => view.getInt16(44 + i * 2, true)
    expect(s(0)).toBe(16384)
    expect(s(1)).toBe(-16384)
    expect(s(2)).toBe(32767)
    expect(s(3)).toBe(-32768)
    expect(s(4)).toBe(0)
    expect(s(5)).toBe(0)
  })

  it('round-trips through decodeWav16', () => {
    const samples = sine(440, 16_000, 0.25, 0.8)
    const decoded = decodeWav16(encodeWav16(samples))
    expect(decoded.sampleRate).toBe(16_000)
    expect(decoded.channels).toBe(1)
    expect(decoded.samples.length).toBe(samples.length)
    let maxErr = 0
    for (let i = 0; i < samples.length; i++) {
      maxErr = Math.max(maxErr, Math.abs((decoded.samples[i] as number) - (samples[i] as number)))
    }
    // ≤ half an LSB of rounding + the 32767/32768 positive-scale asymmetry.
    expect(maxErr).toBeLessThan(1 / 16_384)
  })

  it('rejects invalid sample rates', () => {
    expect(() => encodeWav16(new Float32Array(1), 0)).toThrow(RangeError)
    expect(() => encodeWav16(new Float32Array(1), 44_100.5)).toThrow(RangeError)
  })
})

describe('decodeWav16', () => {
  it('reads the repository fixtures (with extra chunks)', () => {
    const a = fixture('speech-en-16k.wav')
    const b = fixture('speech-en-48k.wav')
    expect(a.sampleRate).toBe(16_000)
    expect(b.sampleRate).toBe(48_000)
    expect(a.samples.length / 16_000).toBeCloseTo(8.54, 1)
    expect(b.samples.length / 48_000).toBeCloseTo(8.54, 1)
  })

  it('averages stereo and rejects non-WAV / non-PCM16 data', () => {
    const stereo = new Uint8Array(44 + 8)
    const v = new DataView(stereo.buffer)
    stereo.set(
      [...'RIFF'].map((c) => c.charCodeAt(0)),
      0,
    )
    v.setUint32(4, 36 + 8, true)
    stereo.set(
      [...'WAVEfmt '].map((c) => c.charCodeAt(0)),
      8,
    )
    v.setUint32(16, 16, true)
    v.setUint16(20, 1, true)
    v.setUint16(22, 2, true)
    v.setUint32(24, 16_000, true)
    v.setUint16(34, 16, true)
    stereo.set(
      [...'data'].map((c) => c.charCodeAt(0)),
      36,
    )
    v.setUint32(40, 8, true)
    v.setInt16(44, 16384, true)
    v.setInt16(46, 0, true)
    v.setInt16(48, -16384, true)
    v.setInt16(50, -16384, true)
    const decoded = decodeWav16(stereo)
    expect(decoded.channels).toBe(2)
    expect(Array.from(decoded.samples)).toEqual([0.25, -0.5])

    expect(() => decodeWav16(new Uint8Array(20))).toThrow(/RIFF/)
    v.setUint16(34, 24, true)
    expect(() => decodeWav16(stereo)).toThrow(/Unsupported/)
  })
})
