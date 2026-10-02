import { describe, expect, it } from 'vitest'
import {
  dbfsToRms,
  goertzelPower,
  powerToDb,
  rms,
  rmsToDbfs,
  sinePowerToDbfs,
} from '@renderer/audio/goertzel'
import { concat, rng, sine } from './helpers'

describe('goertzelPower', () => {
  it('returns A²/2 for a sine on a bin', () => {
    const p = goertzelPower(sine(1000, 16_000, 0.1, 0.25), 16_000, 1000)
    expect(p).toBeCloseTo(0.25 ** 2 / 2, 6)
    expect(sinePowerToDbfs(p)).toBeCloseTo(20 * Math.log10(0.25), 3)
  })

  it('handles frequencies between bins (440 Hz over 1 s at 16 kHz)', () => {
    const p = goertzelPower(sine(440, 16_000, 1, 0.5, 0.3), 16_000, 440)
    expect(Math.sqrt(2 * p)).toBeCloseTo(0.5, 3)
  })

  it('is selective: other integer-cycle frequencies read ~0', () => {
    const block = sine(1000, 16_000, 0.1, 0.5)
    expect(goertzelPower(block, 16_000, 1250)).toBeLessThan(1e-10)
    expect(goertzelPower(block, 16_000, 1500)).toBeLessThan(1e-10)
  })

  it('measures only [start, end)', () => {
    const signal = concat([new Float32Array(1600), sine(1500, 16_000, 0.1, 0.5)])
    expect(goertzelPower(signal, 16_000, 1500, 0, 1600)).toBe(0)
    expect(goertzelPower(signal, 16_000, 1500, 1600, 3200)).toBeCloseTo(0.125, 6)
    expect(goertzelPower(signal, 16_000, 1500, 10, 10)).toBe(0)
  })

  it('reads white noise far below a tone of the same RMS', () => {
    const random = rng(7)
    const noise = new Float32Array(16_000)
    for (let i = 0; i < noise.length; i++) noise[i] = (random() - 0.5) * 0.5
    const tone = sine(1000, 16_000, 1, rms(noise) * Math.SQRT2)
    const ratio =
      powerToDb(goertzelPower(tone, 16_000, 1000)) - powerToDb(goertzelPower(noise, 16_000, 1000))
    expect(ratio).toBeGreaterThan(25)
  })
})

describe('dB helpers', () => {
  it('converts between RMS and dBFS', () => {
    expect(rmsToDbfs(1)).toBe(0)
    expect(rmsToDbfs(0.1)).toBeCloseTo(-20, 9)
    expect(rmsToDbfs(0)).toBe(-200)
    expect(dbfsToRms(-50)).toBeCloseTo(0.003162, 6)
    expect(rmsToDbfs(dbfsToRms(-37.5))).toBeCloseTo(-37.5, 9)
  })

  it('floors power so silence stays finite', () => {
    expect(powerToDb(0)).toBe(-200)
    expect(powerToDb(1)).toBe(0)
  })

  it('computes RMS over a range', () => {
    expect(rms(new Float32Array([1, -1, 1, -1]))).toBe(1)
    expect(rms(new Float32Array([0, 0, 3, 4]), 2, 4)).toBeCloseTo(Math.sqrt(12.5), 9)
    expect(rms(new Float32Array(0))).toBe(0)
  })
})
