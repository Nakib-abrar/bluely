/** 5375000 → "1:29:35", 83000 → "1:23" (matches the session list duration badge). */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '0:00'
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** "1:18am" */
export function formatClock(epochMs: number): string {
  const d = new Date(epochMs)
  let h = d.getHours()
  const m = String(d.getMinutes()).padStart(2, '0')
  const suffix = h >= 12 ? 'pm' : 'am'
  h = h % 12 || 12
  return `${h}:${m}${suffix}`
}

/** "Sat, Jan 10" (adds the year when it is not the current year). */
export function formatDay(epochMs: number, now = Date.now()): string {
  const d = new Date(epochMs)
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  return d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
}

/** Local calendar-day key used to group sessions. */
export function dayKey(epochMs: number): string {
  const d = new Date(epochMs)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

/** "12:04" elapsed timer (or "1:02:03"). */
export function formatElapsed(ms: number): string {
  return formatDuration(ms)
}

export function formatUsd(v: number | null | undefined): string {
  if (v == null) return '—'
  if (v === 0) return '$0.00'
  if (v < 0.01) return `$${v.toFixed(4)}`
  return `$${v.toFixed(2)}`
}

/** Per-token USD price → "$0.59 / M tokens" */
export function formatPerMillion(perToken: number | null | undefined): string {
  if (perToken == null) return '—'
  const perM = perToken * 1_000_000
  if (perM === 0) return 'free'
  return `$${perM < 1 ? perM.toFixed(3) : perM.toFixed(2)}/M`
}
