import { POST_CALL_PARTS, type PostCallPart } from './postCall'

/**
 * A session's stored post-call error (summary_json.postCallError) is either one entry per part
 * that failed, "notes: <message> · email: <message>", or a single whole-run message ("nothing
 * was transcribed"). The renderer's parsePostCallError reads it with the same rule.
 */
export type PartErrors = Map<PostCallPart, string>

const PART_ERROR = /^(notes|actions|email): (.+)$/s
/**
 * Splits only where the next "<part>: " entry starts, so a message that itself contains " · "
 * (e.g. a provider's error detail) stays whole. Same rule as the renderer's parsePostCallError.
 */
const PART_ERROR_SEPARATOR = / · (?=(?:notes|actions|email): )/

/**
 * Inverse of formatPartErrors: "notes: msg · email: msg" → per-part messages. Text that is not a
 * per-part entry (a whole-run failure, "nothing was transcribed") is dropped: the run that reads
 * it replaces it.
 */
export function parsePartErrors(stored: string | null): PartErrors {
  const out: PartErrors = new Map()
  for (const entry of (stored ?? '').split(PART_ERROR_SEPARATOR)) {
    const match = PART_ERROR.exec(entry.trim())
    if (match) out.set(match[1] as PostCallPart, match[2] as string)
  }
  return out
}

export function formatPartErrors(errors: PartErrors): string | null {
  const segments = POST_CALL_PARTS.filter((p) => errors.has(p)).map(
    (p) => `${p}: ${errors.get(p) ?? ''}`,
  )
  return segments.length ? segments.join(' · ') : null
}

/**
 * `stored` without the error of `part`, e.g. once the user has written that part themselves.
 * Anything else (the other parts' errors, a whole-run message) is returned unchanged.
 */
export function withoutPartError(stored: string | null, part: PostCallPart): string | null {
  const errors = parsePartErrors(stored)
  if (!errors.has(part)) return stored
  errors.delete(part)
  return formatPartErrors(errors)
}
