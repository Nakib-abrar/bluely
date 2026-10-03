/** Longest meeting title the editor accepts (matches the input's maxLength). */
export const MAX_TITLE_LENGTH = 200

/**
 * What a finished title edit should store, or null when nothing should be renamed.
 *
 * `initial` is what the input started with and `current` is the stored title now; they differ
 * when the title changed in the background while the editor was open (notes naming an untitled
 * meeting, a rename from another window). An edit the user did not change must never write the
 * value it started with back over that newer title, so only a draft that differs from where the
 * edit started counts. An empty draft never renames.
 */
export function titleToCommit(draft: string, initial: string, current: string): string | null {
  const next = normalize(draft)
  if (!next || next === normalize(initial) || next === normalize(current)) return null
  return next
}

function normalize(title: string): string {
  return title.trim().slice(0, MAX_TITLE_LENGTH)
}
