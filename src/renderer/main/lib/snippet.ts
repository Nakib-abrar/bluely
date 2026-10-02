import { SNIPPET_MARK_END, SNIPPET_MARK_START } from '@shared/constants'

/** One run of text inside a search snippet; `mark` runs are rendered as <mark>. */
export interface TextPart {
  text: string
  mark: boolean
}

function pushPart(parts: TextPart[], text: string, mark: boolean): void {
  if (!text) return
  const last = parts[parts.length - 1]
  if (last && last.mark === mark) last.text += text
  else parts.push({ text, mark })
}

/**
 * Splits an FTS snippet into plain and highlighted runs using the control-character markers
 * from main. Rendering the runs as React text keeps snippet content out of innerHTML entirely.
 * Unbalanced markers are tolerated: a missing end marks the rest, a stray end is ignored.
 */
export function splitSnippet(snippet: string): TextPart[] {
  const parts: TextPart[] = []
  let mark = false
  let buf = ''
  for (const ch of snippet) {
    if (ch === SNIPPET_MARK_START || ch === SNIPPET_MARK_END) {
      pushPart(parts, buf, mark)
      buf = ''
      mark = ch === SNIPPET_MARK_START
      continue
    }
    buf += ch
  }
  pushPart(parts, buf, mark)
  return parts
}

/** Highlights every case-insensitive occurrence of `query` in `text` (transcript filter). */
export function highlightText(text: string, query: string): TextPart[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return text ? [{ text, mark: false }] : []
  const parts: TextPart[] = []
  const hay = text.toLowerCase()
  let from = 0
  for (;;) {
    const at = hay.indexOf(needle, from)
    if (at < 0) break
    pushPart(parts, text.slice(from, at), false)
    pushPart(parts, text.slice(at, at + needle.length), true)
    from = at + needle.length
  }
  pushPart(parts, text.slice(from), false)
  return parts
}
