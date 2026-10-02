/** Perceptual mapping for the Me/Them meters: speech RMS is small, so a square root spreads it out. */
export function levelToScale(rms: number): number {
  if (!Number.isFinite(rms) || rms <= 0) return 0
  return Math.min(1, Math.sqrt(rms) * 2.2)
}
