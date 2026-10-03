export type PostCallPart = 'notes' | 'actions' | 'email'

export interface PostCallPartError {
  part: PostCallPart
  message: string
}

const PART_PREFIX = /^(notes|actions|email): /
// Main joins one "<part>: <message>" entry per failed part with " · ". Only split where the next
// entry starts, so a message that itself contains " · " stays whole.
const SEPARATOR = / · (?=(?:notes|actions|email): )/

/**
 * Splits a session's postCallError into the parts that failed. Main stores partial failures as
 * "notes: <message> · email: <message>" with English part ids, which must not reach the UI
 * verbatim. Returns null for any other error text (a whole-run failure, "nothing transcribed"),
 * which is shown as is.
 */
export function parsePostCallError(raw: string | null | undefined): PostCallPartError[] | null {
  if (!raw) return null
  const entries = raw.split(SEPARATOR)
  const out: PostCallPartError[] = []
  for (const entry of entries) {
    const m = PART_PREFIX.exec(entry)
    if (!m) return null
    out.push({ part: m[1] as PostCallPart, message: entry.slice(m[0].length).trim() })
  }
  return out.length > 0 ? out : null
}
