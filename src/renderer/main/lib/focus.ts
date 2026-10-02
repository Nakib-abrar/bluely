/** Attribute marking keyboard-navigable search results (↓/↑ from the search box). */
export const RESULT_ITEM_ATTR = 'data-result-item'

function items(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(`[${RESULT_ITEM_ATTR}]`)]
}

/** Focuses the first search result. Returns false when there are none. */
export function focusFirstResult(): boolean {
  const first = items()[0]
  if (!first) return false
  first.focus()
  return true
}

/**
 * Moves focus to the previous/next result. Returns false when moving up past the first
 * item, so the caller can hand focus back to the search box.
 */
export function moveResultFocus(from: HTMLElement, delta: 1 | -1): boolean {
  const list = items()
  const at = list.indexOf(from)
  const next = list[at + delta]
  if (at < 0 || !next) return delta === 1
  next.focus()
  next.scrollIntoView({ block: 'nearest' })
  return true
}
