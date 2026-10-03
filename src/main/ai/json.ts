/**
 * Lenient JSON extraction for model output.
 *
 * Even with `response_format: json_object`, models (and providers that ignore the flag) wrap
 * JSON in ```json fences, add a sentence before or after it, or leave a trailing comma. We recover
 * the object instead of failing the whole post-call step.
 */

/** Stop after this many candidate `{` positions so pathological input stays cheap. */
const MAX_CANDIDATES = 32

const FENCE_RE = /```[ \t]*(?:json5?|JSON)?[ \t]*\r?\n?([\s\S]*?)```/g

/**
 * Returns the end index (inclusive) of the balanced `{…}` (or `[…]`) starting at `start`, or -1.
 * Brackets inside JSON strings (including escaped quotes) are ignored.
 */
function findBalancedEnd(text: string, start: number, open = '{', close = '}'): number {
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** Removes commas that directly precede `}` or `]` (outside strings). */
export function stripTrailingCommas(json: string): string {
  let out = ''
  let inString = false
  for (let i = 0; i < json.length; i++) {
    const ch = json[i] as string
    if (inString) {
      out += ch
      if (ch === '\\' && i + 1 < json.length) {
        out += json[i + 1]
        i++
      } else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === ',') {
      let j = i + 1
      while (j < json.length && /\s/.test(json[j] as string)) j++
      if (json[j] === '}' || json[j] === ']') continue
    }
    out += ch
  }
  return out
}

function tryParseObject(candidate: string): Record<string, unknown> | null {
  for (const attempt of [candidate, stripTrailingCommas(candidate)]) {
    try {
      const value: unknown = JSON.parse(attempt)
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        return value as Record<string, unknown>
      }
      return null
    } catch {
      // Try the next repair (a single trailing-comma pass), then give up on this candidate.
    }
  }
  return null
}

function tryParseArray(candidate: string): unknown[] | null {
  for (const attempt of [candidate, stripTrailingCommas(candidate)]) {
    try {
      const value: unknown = JSON.parse(attempt)
      return Array.isArray(value) ? value : null
    } catch {
      // Try the trailing-comma repair, then give up.
    }
  }
  return null
}

function scan(text: string): Record<string, unknown> | null {
  let from = 0
  for (let n = 0; n < MAX_CANDIDATES; n++) {
    const start = text.indexOf('{', from)
    if (start < 0) return null
    const end = findBalancedEnd(text, start)
    if (end < 0) {
      // Unbalanced from here on; a later `{` may still start a complete object.
      from = start + 1
      continue
    }
    const parsed = tryParseObject(text.slice(start, end + 1))
    if (parsed) return parsed
    // Skip the whole invalid block (e.g. "{name}" in prose) rather than returning one of its
    // nested objects, which would be a fragment of something else.
    from = end + 1
  }
  return null
}

/** A top-level array that starts before any object (e.g. `[{…}, {…}]`), else null. */
function scanArray(text: string): unknown[] | null {
  const start = text.indexOf('[')
  if (start < 0) return null
  const firstObject = text.indexOf('{')
  if (firstObject >= 0 && firstObject < start) return null
  const end = findBalancedEnd(text, start, '[', ']')
  return end < 0 ? null : tryParseArray(text.slice(start, end + 1))
}

function extract(
  text: string | null | undefined,
  scanOne: (text: string) => unknown,
): unknown | null {
  if (typeof text !== 'string') return null
  // trim() also strips a leading byte-order mark (U+FEFF counts as whitespace).
  const trimmed = text.trim()
  if (!trimmed) return null
  for (const match of trimmed.matchAll(FENCE_RE)) {
    const found = scanOne(match[1] ?? '')
    if (found) return found
  }
  return scanOne(trimmed)
}

/**
 * Extracts the first JSON object from model output: prefers fenced blocks, then the outermost
 * balanced `{…}` (string/escape aware), tolerating trailing commas. Returns null when none parses.
 */
export function extractJsonObject(text: string | null | undefined): unknown | null {
  return extract(text, scan)
}

/**
 * Like extractJsonObject, but also returns a top-level JSON array when the output is one (e.g. a
 * bare list of action items instead of `{"items": [...]}`), rather than its first element.
 */
export function extractJsonValue(text: string | null | undefined): unknown | null {
  return extract(text, (t) => scanArray(t) ?? scan(t))
}
