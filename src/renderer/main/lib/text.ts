import type { SearchHitKind, SessionTab } from '@shared/types'

/** "google/gemini-2.5-flash" → "gemini-2.5-flash" (the subtitle under the Start button). */
export function shortModelId(model: string): string {
  const slash = model.lastIndexOf('/')
  return slash >= 0 ? model.slice(slash + 1) : model
}

/** First letter of the local profile name for the avatar button, or null when unset. */
export function profileInitial(name: string): string | null {
  const first = name.trim().charAt(0)
  return first ? first.toLocaleUpperCase() : null
}

const QUESTION_START =
  /^(who|what|when|where|why|how|which|whose|whom|did|does|do|is|are|was|were|can|could|should|would|will|has|have|had|summari[sz]e|list|tell|explain|find|show)\b/i

/**
 * Local fallback for "does this query look like a question?". Main decides this in
 * SearchResult.looksLikeQuestion; this is only used while search is unavailable.
 */
export function looksLikeQuestion(query: string): boolean {
  const q = query.trim()
  if (q.length < 6) return false
  return q.endsWith('?') || (QUESTION_START.test(q) && q.split(/\s+/).length >= 3)
}

/** Which session tab a search hit opens. */
export function tabForHit(kind: SearchHitKind): SessionTab | undefined {
  switch (kind) {
    case 'transcript':
      return 'transcript'
    case 'notes':
      return 'notes'
    case 'action_item':
      return 'actions'
    case 'email':
      return 'email'
    default:
      return undefined
  }
}

/** "Jan 10" (adds the year when it is not the current year). Used on citation chips. */
export function formatShortDate(epochMs: number, now = Date.now()): string {
  const d = new Date(epochMs)
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
}
