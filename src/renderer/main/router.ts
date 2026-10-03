import { createContext, useContext } from 'react'
import type { MainWindowRoute, SessionTab, SettingsPage } from '@shared/types'

/** State-based router for the main window: a stack of routes, the last one is current. */
export interface RouterState {
  stack: MainWindowRoute[]
}

export type RouterAction =
  | { type: 'push'; route: MainWindowRoute }
  | { type: 'replace'; route: MainWindowRoute }
  | { type: 'back' }
  | { type: 'reset'; route: MainWindowRoute }

const MAX_STACK = 50

export const initialRouterState: RouterState = { stack: [{ name: 'home' }] }

function sameRoute(a: MainWindowRoute, b: MainWindowRoute): boolean {
  if (a.name !== b.name) return false
  if (a.name === 'session' && b.name === 'session') return a.sessionId === b.sessionId
  return true
}

export function currentRoute(state: RouterState): MainWindowRoute {
  return state.stack[state.stack.length - 1] ?? { name: 'home' }
}

/** Pure router reducer. Pushing the current page again only updates it (e.g. a new tab). */
export function routerReducer(state: RouterState, action: RouterAction): RouterState {
  const top = currentRoute(state)
  switch (action.type) {
    case 'push': {
      if (action.route.name === 'home') return { stack: [action.route] }
      if (sameRoute(top, action.route))
        return { stack: [...state.stack.slice(0, -1), action.route] }
      return { stack: [...state.stack, action.route].slice(-MAX_STACK) }
    }
    case 'replace':
      return { stack: [...state.stack.slice(0, -1), action.route] }
    case 'back':
      return state.stack.length > 1 ? { stack: state.stack.slice(0, -1) } : state
    case 'reset':
      return { stack: [action.route] }
  }
}

/**
 * Where keyboard focus belongs on the home page after 'back': the history row of the meeting
 * being left (a session id), the home page itself (null; e.g. the meeting was just deleted), or
 * undefined when back does not land on the home page (the next page focuses its own heading).
 */
export function homeFocusAfterBack(
  state: RouterState,
  opts: { deleted?: boolean } = {},
): string | null | undefined {
  if (state.stack.length < 2 || state.stack[state.stack.length - 2]?.name !== 'home')
    return undefined
  const top = currentRoute(state)
  return !opts.deleted && top.name === 'session' ? top.sessionId : null
}

/** Navigation API shared with every page component through context. */
export interface Nav {
  route: MainWindowRoute
  canGoBack: boolean
  back(): void
  /** Back after the current meeting was deleted (focus cannot return to its row). */
  backAfterDelete(): void
  openSession(sessionId: string, tab?: SessionTab): void
  setTab(tab: SessionTab): void
  goHome(): void
  openSettings(page?: SettingsPage | null): void
}

export const NavContext = createContext<Nav | null>(null)

export function useNav(): Nav {
  const nav = useContext(NavContext)
  if (!nav) throw new Error('useNav() outside NavContext')
  return nav
}
