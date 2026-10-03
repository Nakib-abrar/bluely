/** Longest meeting title the editor accepts (matches the input's maxLength). */
export const MAX_TITLE_LENGTH = 200

/**
 * What a finished title edit should store, or null when nothing should be renamed.
 *
 * `current` is the stored title now, which can differ from what the edit started with when the
 * title changed in the background while the editor was open (notes naming an untitled meeting,
 * a rename from another window). `touched` says whether the user typed in the input at all.
 * An edit the user never typed in is a no-op, so the value it started with is never written
 * back over a newer title. A typed edit stores exactly what the input shows, even when that
 * equals the start value again, as long as it differs from the stored title. An empty draft
 * never renames.
 */
export function titleToCommit(draft: string, current: string, touched: boolean): string | null {
  if (!touched) return null
  const next = normalize(draft)
  if (!next || next === normalize(current)) return null
  return next
}

function normalize(title: string): string {
  return title.trim().slice(0, MAX_TITLE_LENGTH)
}
