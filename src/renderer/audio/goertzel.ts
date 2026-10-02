/**
 * Single-frequency power estimation (Goertzel) and dB helpers. Pure; used by the system audio
 * test to find its test tone in the captured loopback stream, and by unit tests.
 */

/** Smallest power reported, so dB conversions stay finite on digital silence (−200 dB). */
export const POWER_FLOOR = 1e-20

/**
 * Mean-square power of the `freq` component of `samples[start, end)`.
 *
 * Scaled so a sine of amplitude A at `freq` returns A²/2 (its mean-square value): a full-scale
 * sine reads 0.5, i.e. 0 dBFS through `sinePowerToDbfs`. `freq` need not fall on a DFT bin.
 */
export function goertzelPower(
  samples: Float32Array,
  sampleRate: number,
  freq: number,
  start = 0,
  end = samples.length,
): number {
  const n = end - start
  if (n <= 0) return 0
  const coeff = 2 * Math.cos((2 * Math.PI * freq) / sampleRate)
  let s1 = 0
  let s2 = 0
  for (let i = start; i < end; i++) {
    const s0 = (samples[i] as number) + coeff * s1 - s2
    s2 = s1
    s1 = s0
  }
  const magSq = s1 * s1 + s2 * s2 - coeff * s1 * s2
  return Math.max(0, (2 * magSq) / (n * n))
}

/** 10·log10(power), floored so silence gives a finite number. */
export function powerToDb(power: number): number {
  return 10 * Math.log10(Math.max(power, POWER_FLOOR))
}

/** dBFS of a sine whose mean-square power is `power` (full-scale sine = 0 dBFS). */
export function sinePowerToDbfs(power: number): number {
  return powerToDb(2 * power)
}

/** RMS (of a frame) to dBFS, where RMS 1.0 = 0 dBFS. */
export function rmsToDbfs(rms: number): number {
  return 20 * Math.log10(Math.max(rms, 1e-10))
}

/** Inverse of `rmsToDbfs`. */
export function dbfsToRms(db: number): number {
  return Math.pow(10, db / 20)
}

/** Root-mean-square of `samples[start, end)`. */
export function rms(samples: Float32Array, start = 0, end = samples.length): number {
  const n = end - start
  if (n <= 0) return 0
  let sum = 0
  for (let i = start; i < end; i++) {
    const s = samples[i] as number
    sum += s * s
  }
  return Math.sqrt(sum / n)
}
