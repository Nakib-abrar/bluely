import { describe, expect, it } from 'vitest'
import { AppError } from '@main/errors'
import {
  isLikelySilent,
  isPcm16,
  parseWavHeader,
  pcm16Levels,
  pcm16Rms,
  SILENCE_RMS_THRESHOLD,
} from '@main/providers/stt/wav'
import { fixture, fmtBody, joinSamples, makeWav, silence, tone, wavFromBytes } from './helpers'

function expectInvalid(fn: () => unknown, reason?: RegExp) {
  let caught: unknown
  try {
    fn()
  } catch (err) {
    caught = err
  }
  expect(caught).toBeInstanceOf(AppError)
  expect((caught as AppError).code).toBe('invalid_audio')
  if (reason) expect((caught as AppError).message).toMatch(reason)
}

describe('parseWavHeader', () => {
  it('parses a canonical 44-byte header', () => {
    const wav = makeWav(silence(0.5))
    const h = parseWavHeader(wav)
    expect(h).toEqual({
      audioFormat: 1,
      sampleRate: 16000,
      channels: 1,
      bitsPerSample: 16,
      dataOffset: 44,
      dataBytes: 16000,
      durationSec: 0.5,
    })
    expect(isPcm16(h)).toBe(true)
  })

  it('parses the 16 kHz speech fixture, skipping its LIST chunk', () => {
    const wav = fixture('speech-en-16k.wav')
    const h = parseWavHeader(wav)
    expect(h.sampleRate).toBe(16000)
    expect(h.channels).toBe(1)
    expect(h.bitsPerSample).toBe(16)
    // RIFF(12) + fmt(8+16) + LIST(8+26) + data header(8)
    expect(h.dataOffset).toBe(78)
    expect(h.dataBytes).toBe(273202)
    expect(h.durationSec).toBeCloseTo(273202 / 32000, 6)
  })

  it('parses the 48 kHz fixture', () => {
    const h = parseWavHeader(fixture('speech-en-48k.wav'))
    expect(h.sampleRate).toBe(48000)
    expect(h.durationSec).toBeCloseTo(819606 / 96000, 6)
  })

  it('walks multiple chunks, including odd-sized ones with a pad byte', () => {
    const list = new Uint8Array(27).fill(0x41) // odd size → 1 pad byte
    const fact = new Uint8Array(4)
    const wav = makeWav(tone(0.25, 0.5), {
      extraChunks: [
        { id: 'LIST', body: list },
        { id: 'fact', body: fact },
      ],
    })
    const h = parseWavHeader(wav)
    expect(h.dataOffset).toBe(12 + 24 + (8 + 28) + (8 + 4) + 8)
    expect(h.dataBytes).toBe(8000)
    expect(h.durationSec).toBeCloseTo(0.25, 6)
  })

  it('handles byte views that do not start at offset 0 of their buffer', () => {
    const wav = makeWav(tone(0.1, 0.5))
    const big = new Uint8Array(wav.byteLength + 7)
    big.set(wav, 7)
    const view = big.subarray(7)
    const h = parseWavHeader(view)
    expect(h.dataOffset).toBe(44)
    expect(pcm16Rms(view, h)).toBeCloseTo(pcm16Rms(wav, parseWavHeader(wav)), 6)
  })

  it('clamps a data chunk that declares more bytes than the file holds', () => {
    const wav = makeWav(tone(0.5, 0.3), { declaredDataBytes: 1_000_000 })
    const h = parseWavHeader(wav)
    expect(h.dataBytes).toBe(16000)
    expect(h.durationSec).toBeCloseTo(0.5, 6)
    // Streaming writers use 0xFFFFFFFF for "unknown".
    const streamed = makeWav(tone(0.5, 0.3), { declaredDataBytes: 0xffffffff })
    expect(parseWavHeader(streamed).dataBytes).toBe(16000)
  })

  it('keeps whole frames only when the data ends mid-sample', () => {
    const full = makeWav(tone(0.1, 0.3))
    const cut = full.subarray(0, full.byteLength - 1)
    expect(parseWavHeader(cut).dataBytes).toBe(3198)
  })

  it('resolves WAVE_FORMAT_EXTENSIBLE to the sub-format', () => {
    const data = new Uint8Array(3200)
    const h = parseWavHeader(wavFromBytes(data, fmtBody({ format: 0xfffe, subFormat: 1 })))
    expect(h.audioFormat).toBe(1)
    expect(isPcm16(h)).toBe(true)
  })

  it('accepts 32-bit float but reports it as not PCM16', () => {
    const h = parseWavHeader(wavFromBytes(new Uint8Array(6400), fmtBody({ format: 3, bits: 32 })))
    expect(h.audioFormat).toBe(3)
    expect(isPcm16(h)).toBe(false)
    expect(h.durationSec).toBeCloseTo(0.1, 6)
  })

  it('rejects truncated headers', () => {
    const wav = makeWav(tone(0.1, 0.3))
    expectInvalid(() => parseWavHeader(wav.subarray(0, 8)), /too short/)
    expectInvalid(() => parseWavHeader(wav.subarray(0, 30)), /truncated fmt/)
    // fmt complete but no data chunk header yet.
    expectInvalid(() => parseWavHeader(wav.subarray(0, 36)), /missing data chunk/)
    expectInvalid(() => parseWavHeader(wav.subarray(0, 12)), /missing fmt chunk/)
  })

  it('rejects non-RIFF input', () => {
    expectInvalid(() => parseWavHeader(new Uint8Array(0)))
    expectInvalid(() => parseWavHeader(new TextEncoder().encode('ID3\u0004 this is an mp3 file')))
    const rifx = makeWav(silence(0.1))
    rifx.set([0x52, 0x49, 0x46, 0x58], 0) // "RIFX"
    expectInvalid(() => parseWavHeader(rifx), /RIFF\/WAVE/)
    const avi = makeWav(silence(0.1))
    avi.set([0x41, 0x56, 0x49, 0x20], 8) // "AVI "
    expectInvalid(() => parseWavHeader(avi), /RIFF\/WAVE/)
    expectInvalid(() => parseWavHeader('RIFF' as unknown as Uint8Array), /expected bytes/)
  })

  it('rejects unsupported or nonsensical formats', () => {
    const data = new Uint8Array(100)
    expectInvalid(() => parseWavHeader(wavFromBytes(data, fmtBody({ format: 2 }))), /format 2/)
    expectInvalid(() => parseWavHeader(wavFromBytes(data, fmtBody({ bits: 12 }))), /bits/)
    expectInvalid(() => parseWavHeader(wavFromBytes(data, fmtBody({ channels: 0 }))), /channel/)
    expectInvalid(
      () => parseWavHeader(wavFromBytes(data, fmtBody({ sampleRate: 10 }))),
      /sample rate/,
    )
    expectInvalid(
      () => parseWavHeader(wavFromBytes(data, fmtBody({ format: 3, bits: 16 }))),
      /bits/,
    )
  })

  it('rejects a data chunk that comes before fmt', () => {
    const good = makeWav(silence(0.01))
    // Rename "fmt " to "junk" so the parser meets "data" first.
    const bad = good.slice()
    bad.set([0x6a, 0x75, 0x6e, 0x6b], 12)
    expectInvalid(() => parseWavHeader(bad), /before fmt/)
  })
})

describe('levels and silence', () => {
  it('computes RMS in 0..1', () => {
    const silent = makeWav(silence(0.5))
    expect(pcm16Rms(silent, parseWavHeader(silent))).toBe(0)
    const sine = makeWav(tone(1, 0.5))
    expect(pcm16Rms(sine, parseWavHeader(sine))).toBeCloseTo(0.5 / Math.SQRT2, 2)
    const square = makeWav(Array.from({ length: 1600 }, (_, i) => (i % 2 ? 1 : -1)))
    expect(pcm16Rms(square, parseWavHeader(square))).toBeCloseTo(1, 3)
  })

  it('reports the loudest window separately from the mean', () => {
    const wav = makeWav(joinSamples(silence(2), tone(0.1, 0.2), silence(2)))
    const levels = pcm16Levels(wav, parseWavHeader(wav))
    const toneRms = 0.2 / Math.SQRT2
    // The tone starts on a 100 ms window boundary, so one window holds exactly the tone.
    expect(levels.peakWindowRms).toBeCloseTo(toneRms, 3)
    expect(levels.rms).toBeCloseTo(toneRms * Math.sqrt(0.1 / 4.1), 3)
  })

  it('pcm16Levels refuses non-PCM16 data', () => {
    const wav = wavFromBytes(new Uint8Array(6400), fmtBody({ format: 3, bits: 32 }))
    expect(() => pcm16Levels(wav, parseWavHeader(wav))).toThrow(AppError)
  })

  it('detects digital silence and faint hiss as silent', () => {
    expect(isLikelySilent(makeWav(silence(0.2)))).toBe(true)
    const hiss = Array.from({ length: 16000 }, (_, i) => (i % 2 ? 0.002 : -0.002))
    expect(isLikelySilent(makeWav(hiss))).toBe(true)
    // A header-only file has nothing to say either.
    expect(isLikelySilent(makeWav([]))).toBe(true)
  })

  it('never calls real speech silent', () => {
    expect(isLikelySilent(fixture('speech-en-16k.wav'))).toBe(false)
    expect(isLikelySilent(fixture('speech-en-48k.wav'))).toBe(false)
  })

  it('keeps a short quiet word inside a long, otherwise silent segment', () => {
    // Mean RMS is below the threshold, but one 100 ms window clearly holds sound.
    const wav = makeWav(joinSamples(silence(6), tone(0.12, 0.02), silence(6)))
    expect(pcm16Rms(wav, parseWavHeader(wav))).toBeLessThan(SILENCE_RMS_THRESHOLD)
    expect(isLikelySilent(wav)).toBe(false)
  })

  it('honours a custom threshold', () => {
    const quiet = makeWav(tone(0.5, 0.01)) // RMS ≈ 0.007
    expect(isLikelySilent(quiet)).toBe(false)
    expect(isLikelySilent(quiet, 0.02)).toBe(true)
  })

  it('does not judge formats it cannot measure', () => {
    const float = wavFromBytes(new Uint8Array(6400), fmtBody({ format: 3, bits: 32 }))
    expect(isLikelySilent(float)).toBe(false)
  })

  it('throws invalid_audio for garbage', () => {
    expectInvalid(() => isLikelySilent(new Uint8Array([1, 2, 3])))
  })
})
