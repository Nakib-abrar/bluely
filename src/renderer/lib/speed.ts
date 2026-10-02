import type { SpeedStats } from '@shared/types'

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`
}

/** Short model name: "meta-llama/llama-3.3-70b-instruct" → "llama-3.3-70b-instruct". */
function shortModel(model: string): string {
  const slash = model.lastIndexOf('/')
  return slash >= 0 ? model.slice(slash + 1) : model
}

/** "⚡ 0.42 s to first word · 1.9 s total · 186 tok/s · groq · llama-3.3-70b" */
export function formatSpeed(stats: SpeedStats): string {
  const parts: string[] = []
  if (stats.ttftMs != null) parts.push(`${seconds(stats.ttftMs)} to first word`)
  parts.push(`${seconds(stats.totalMs)} total`)
  if (stats.tokensPerSec != null && Number.isFinite(stats.tokensPerSec))
    parts.push(`${Math.round(stats.tokensPerSec)} tok/s`)
  if (stats.provider) parts.push(stats.provider.toLowerCase())
  parts.push(shortModel(stats.model))
  return `⚡ ${parts.join(' · ')}`
}
