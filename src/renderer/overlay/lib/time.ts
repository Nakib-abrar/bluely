/** Session offset as "[mm:ss]" without brackets: 72_000 → "01:12", 3_723_000 → "1:02:03". */
export function formatOffset(ms: number): string {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/** Milliseconds between two epoch stamps as seconds ("0.42"), or null when either is missing. */
export function stageSeconds(from: number | null, to: number | null): number | null {
  if (from == null || to == null) return null
  return Math.max(0, to - from) / 1000
}
