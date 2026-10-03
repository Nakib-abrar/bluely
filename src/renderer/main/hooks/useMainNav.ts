import { useCallback, useMemo, useReducer, useRef, useState } from 'react'
import type { MainWindowRoute, SettingsPage } from '@shared/types'
import { useIpcEvent } from '../../hooks/useIpcEvent'
import {
  currentRoute,
  homeFocusAfterBack,
  initialRouterState,
  routerReducer,
  type Nav,
  type RouterState,
} from '../router'

export interface SettingsUi {
  open: boolean
  page: SettingsPage | null
}

/** Focus to restore on the home page after going back (see homeFocusAfterBack). */
export interface HomeFocusRequest {
  /** History row to focus; null = the home page itself. */
  sessionId: string | null
  /** Changes on every request, so going back to the same row twice still refocuses it. */
  seq: number
}

export interface MainNavState {
  nav: Nav
  route: MainWindowRoute
  query: string
  setQuery(query: string): void
  /** True while the title-bar search has text (search results replace the page). */
  searching: boolean
  settingsUi: SettingsUi
  setSettingsOpen(open: boolean): void
  setSettingsPage(page: SettingsPage): void
  /** Leaves onboarding for the home page. */
  goHome(): void
  /** Latest focus request for the home page; App applies it once home is visible. */
  homeFocus: HomeFocusRequest | null
}

/**
 * Router stack + search query + Settings sheet state for the main window, including the
 * 'navigate' and 'settings:open' events from main. Back clears an active search first.
 */
export function useMainNav(): MainNavState {
  const [router, dispatch] = useReducer(routerReducer, initialRouterState)
  const route = currentRoute(router)
  const [query, setQuery] = useState('')
  const [settingsUi, setSettingsUi] = useState<SettingsUi>({ open: false, page: null })
  const searching = query.trim().length > 0
  const canGoBack = searching || router.stack.length > 1
  const [homeFocus, setHomeFocus] = useState<HomeFocusRequest | null>(null)
  const focusSeq = useRef(0)

  const goBack = useCallback((state: RouterState, deleted: boolean) => {
    const target = homeFocusAfterBack(state, { deleted })
    if (target !== undefined) setHomeFocus({ sessionId: target, seq: ++focusSeq.current })
    dispatch({ type: 'back' })
  }, [])

  const back = useCallback(() => {
    if (query) setQuery('')
    else goBack(router, false)
  }, [query, router, goBack])

  const backAfterDelete = useCallback(() => {
    setQuery('')
    goBack(router, true)
  }, [router, goBack])

  const goHome = useCallback(() => {
    setQuery('')
    dispatch({ type: 'reset', route: { name: 'home' } })
  }, [])

  const nav = useMemo<Nav>(
    () => ({
      route,
      canGoBack,
      back,
      backAfterDelete,
      goHome,
      openSession(sessionId, tab) {
        setQuery('')
        dispatch({ type: 'push', route: { name: 'session', sessionId, ...(tab ? { tab } : {}) } })
      },
      setTab(tab) {
        if (route.name === 'session') dispatch({ type: 'replace', route: { ...route, tab } })
      },
      openSettings(page) {
        setSettingsUi({ open: true, page: page ?? null })
      },
    }),
    [route, canGoBack, back, backAfterDelete, goHome],
  )

  useIpcEvent('navigate', (r) => {
    setQuery('')
    dispatch({ type: 'push', route: r })
  })
  useIpcEvent('settings:open', ({ page }) => setSettingsUi({ open: true, page }))

  return {
    nav,
    route,
    query,
    setQuery,
    searching,
    settingsUi,
    setSettingsOpen: (open) => setSettingsUi((s) => ({ ...s, open })),
    setSettingsPage: (page) => setSettingsUi((s) => ({ ...s, page })),
    goHome,
    homeFocus,
  }
}
