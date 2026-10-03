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

/** Attribute on each history row's open button (SessionRow): the session id it opens. */
export const SESSION_ROW_ATTR = 'data-session-id'

/** Attribute on the home page root (HomePage), focused when no row can be. */
export const HOME_FOCUS_ATTR = 'data-home-focus'

function isTyping(el: Element | null): boolean {
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return false
  return el.checkVisibility({ visibilityProperty: true })
}

/**
 * Moves focus to a page heading that just appeared. Leaves it alone when the user already
 * started typing in a visible field (e.g. the search box) while the page loaded.
 */
export function focusPageHeading(heading: HTMLElement | null): void {
  if (!heading || isTyping(document.activeElement)) return
  heading.focus({ preventScroll: true })
}

/**
 * Back on the home page: focuses the history row of the meeting the user came from, or the
 * home page itself when that row is gone (deleted) or `sessionId` is null.
 */
export function focusHomeTarget(sessionId: string | null): void {
  const row = sessionId
    ? document.querySelector<HTMLElement>(`[${SESSION_ROW_ATTR}="${CSS.escape(sessionId)}"]`)
    : null
  if (row) {
    row.focus()
    row.scrollIntoView({ block: 'nearest' })
    return
  }
  document.querySelector<HTMLElement>(`[${HOME_FOCUS_ATTR}]`)?.focus({ preventScroll: true })
}
