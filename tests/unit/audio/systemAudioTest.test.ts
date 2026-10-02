import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MIN_TONE_DBFS,
  REQUIRED_MARGIN_DB,
  SYSTEM_AUDIO_TEST_REASONS,
  TONE_FREQUENCIES,
  analyzeToneCapture,
  testSystemAudio,
} from '@renderer/audio/systemAudioTest'
import { listMicrophones } from '@renderer/audio/micTest'
import { concat, rng } from './helpers'

const SR = 16_000

/** Two-tone test signal like the one testSystemAudio plays (amplitude per tone). */
function tone(seconds: number, amplitude: number): Float32Array {
  const n = Math.round(seconds * SR)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let s = 0
    for (const f of TONE_FREQUENCIES) s += amplitude * Math.sin((2 * Math.PI * f * i) / SR)
    out[i] = s
  }
  return out
}

function noise(seconds: number, amplitude: number, seed = 3): Float32Array {
  const random = rng(seed)
  const out = new Float32Array(Math.round(seconds * SR))
  for (let i = 0; i < out.length; i++) out[i] = (random() * 2 - 1) * amplitude
  return out
}

function add(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(Math.max(a.length, b.length))
  for (let i = 0; i < out.length; i++) out[i] = (a[i] ?? 0) + (b[i] ?? 0)
  return out
}

describe('analyzeToneCapture', () => {
  it('detects the tone after unknown latency on a silent system', () => {
    // 0.5 s baseline, 180 ms output→loopback latency, 1.5 s tone, tail.
    const capture = concat([
      new Float32Array(8000),
      new Float32Array(2880),
      tone(1.5, 0.25),
      new Float32Array(9000),
    ])
    const r = analyzeToneCapture(capture, 8000)
    expect(r.ok).toBe(true)
    expect(r.detectedDb).toBeCloseTo(-12, 0)
    expect(r.marginDb).toBeGreaterThan(REQUIRED_MARGIN_DB)
  })

  it('detects a quiet tone (low system volume) over a quiet noise floor', () => {
    const capture = add(concat([new Float32Array(8000), tone(1.5, 0.003)]), noise(2, 0.0003))
    const r = analyzeToneCapture(capture, 8000)
    expect(r.ok).toBe(true)
    expect(r.detectedDb).toBeLessThan(-45)
  })

  it('fails when the loopback hears nothing', () => {
    const r = analyzeToneCapture(new Float32Array(SR * 3), 8000)
    expect(r.ok).toBe(false)
    expect(r.detectedDb).toBeLessThan(MIN_TONE_DBFS)
  })

  it('fails when only broadband sound is present (music, noise)', () => {
    const r = analyzeToneCapture(noise(3, 0.3), 8000)
    expect(r.ok).toBe(false)
    expect(r.marginDb).toBeLessThan(REQUIRED_MARGIN_DB)
    expect(r.detectedDb).toBeGreaterThan(MIN_TONE_DBFS) // → "too faint vs other sound"
  })

  it('fails when the same tone was already there before the test (not ours)', () => {
    const r = analyzeToneCapture(tone(3, 0.2), 8000)
    expect(r.ok).toBe(false)
  })

  it('needs ≥ 15 dB over the noise floor', () => {
    // Tone barely above loud broadband noise in its bins → not enough.
    const loudNoise = noise(2.5, 0.9, 11)
    const r = analyzeToneCapture(
      add(concat([new Float32Array(8000), tone(1.5, 0.03)]), loudNoise),
      8000,
    )
    expect(r.marginDb).toBeLessThan(REQUIRED_MARGIN_DB)
    expect(r.ok).toBe(false)
  })
})

describe('testSystemAudio', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reports an unavailable loopback without throwing', async () => {
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getDisplayMedia: async () => {
          throw new DOMException('denied', 'NotAllowedError')
        },
      },
    })
    await expect(testSystemAudio()).resolves.toEqual({
      ok: false,
      detectedDb: null,
      reason: SYSTEM_AUDIO_TEST_REASONS.loopbackUnavailable,
    })
  })

  it('rejects with AbortError when already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(testSystemAudio({ signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })
  })
})

describe('listMicrophones', () => {
  afterEach(() => vi.unstubAllGlobals())

  const device = (deviceId: string, label: string, kind: MediaDeviceKind = 'audioinput') =>
    ({ deviceId, label, kind, groupId: 'g' }) as MediaDeviceInfo

  it('lists real inputs, skipping pseudo devices and duplicates', async () => {
    vi.stubGlobal('navigator', {
      mediaDevices: {
        enumerateDevices: async () => [
          device('default', 'Default - Headset'),
          device('communications', 'Communications - Headset'),
          device('a', 'Headset'),
          device('a', 'Headset'),
          device('b', ''),
          device('v', 'Camera', 'videoinput'),
          device('o', 'Speakers', 'audiooutput'),
        ],
        getUserMedia: vi.fn(),
      },
    })
    await expect(listMicrophones()).resolves.toEqual([
      { deviceId: 'a', label: 'Headset' },
      { deviceId: 'b', label: 'Microphone 2' },
    ])
  })

  it('unlocks labels with a throwaway stream when all are hidden', async () => {
    let unlocked = false
    const stop = vi.fn()
    const getUserMedia = vi.fn(async () => {
      unlocked = true
      return { getTracks: () => [{ stop }] }
    })
    vi.stubGlobal('navigator', {
      mediaDevices: {
        enumerateDevices: async () => (unlocked ? [device('a', 'USB Mic')] : [device('a', '')]),
        getUserMedia,
      },
    })
    await expect(listMicrophones()).resolves.toEqual([{ deviceId: 'a', label: 'USB Mic' }])
    expect(getUserMedia).toHaveBeenCalledTimes(1)
    expect(stop).toHaveBeenCalled()
  })

  it('keeps the default entry when it is the only input', async () => {
    vi.stubGlobal('navigator', {
      mediaDevices: {
        enumerateDevices: async () => [device('default', 'Fake Default Audio Input')],
        getUserMedia: vi.fn(),
      },
    })
    await expect(listMicrophones()).resolves.toEqual([
      { deviceId: 'default', label: 'Fake Default Audio Input' },
    ])
  })
})
