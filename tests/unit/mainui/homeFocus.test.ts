import { describe, expect, it } from 'vitest'
import { homeFocusAfterBack, initialRouterState, type RouterState } from '@renderer/main/router'

const session = (sessionId: string) => ({ name: 'session', sessionId }) as const

describe('homeFocusAfterBack (focus restore when going back)', () => {
  it('returns the row of the meeting being left when back lands on home', () => {
    const s: RouterState = { stack: [{ name: 'home' }, session('a')] }
    expect(homeFocusAfterBack(s)).toBe('a')
  })

  it('focuses the home page itself after the meeting was deleted', () => {
    const s: RouterState = { stack: [{ name: 'home' }, session('a')] }
    expect(homeFocusAfterBack(s, { deleted: true })).toBeNull()
  })

  it('does nothing when back lands on another meeting or cannot go back', () => {
    expect(homeFocusAfterBack({ stack: [{ name: 'home' }, session('a'), session('b')] })).toBe(
      undefined,
    )
    expect(homeFocusAfterBack(initialRouterState)).toBeUndefined()
  })
})
