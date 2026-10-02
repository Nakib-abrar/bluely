import { describe, expect, it } from 'vitest'
import {
  currentRoute,
  initialRouterState,
  routerReducer,
  type RouterState,
} from '@renderer/main/router'

const session = (sessionId: string, tab?: 'notes' | 'transcript') =>
  ({ name: 'session', sessionId, ...(tab ? { tab } : {}) }) as const

describe('routerReducer', () => {
  it('starts at home and cannot go back past the root', () => {
    expect(currentRoute(initialRouterState)).toEqual({ name: 'home' })
    expect(routerReducer(initialRouterState, { type: 'back' })).toBe(initialRouterState)
  })

  it('pushes and pops sessions', () => {
    let s: RouterState = routerReducer(initialRouterState, { type: 'push', route: session('a') })
    s = routerReducer(s, { type: 'push', route: session('b') })
    expect(s.stack).toHaveLength(3)
    s = routerReducer(s, { type: 'back' })
    expect(currentRoute(s)).toEqual(session('a'))
  })

  it('pushing the current session again only updates it (e.g. the tab)', () => {
    let s = routerReducer(initialRouterState, { type: 'push', route: session('a') })
    s = routerReducer(s, { type: 'push', route: session('a', 'transcript') })
    expect(s.stack).toHaveLength(2)
    expect(currentRoute(s)).toEqual(session('a', 'transcript'))
  })

  it('pushing home resets the stack; replace swaps the top', () => {
    let s = routerReducer(initialRouterState, { type: 'push', route: session('a') })
    s = routerReducer(s, { type: 'replace', route: session('a', 'notes') })
    expect(s.stack).toHaveLength(2)
    s = routerReducer(s, { type: 'push', route: { name: 'home' } })
    expect(s.stack).toEqual([{ name: 'home' }])
  })
})
