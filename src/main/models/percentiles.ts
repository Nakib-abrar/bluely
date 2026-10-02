/**
 * Nearest-rank percentile: the smallest value such that at least `p`% of the samples are ≤ it.
 * Non-finite values are ignored. Returns null for an empty sample set. `p` is clamped to 0..100
 * (p = 0 returns the minimum).
 */
export function percentile(values: readonly number[], p: number): number | null {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  const n = sorted.length
  if (n === 0) return null
  const clamped = Math.min(100, Math.max(0, Number.isFinite(p) ? p : 0))
  // Multiply before dividing: (0.7 * 10) is 7.000000000000001 in floating point.
  const rank = Math.max(1, Math.ceil((clamped * n) / 100))
  return sorted[Math.min(n, rank) - 1] ?? null
}

/** Median by nearest rank (p50). */
export function median(values: readonly number[]): number | null {
  return percentile(values, 50)
}
