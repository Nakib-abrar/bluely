import { useCallback, useMemo, useReducer, useState } from 'react'
import type { MainWindowRoute, SettingsPage } from '@shared/types'
import { useIpcEvent } from '../../hooks/useIpcEvent'
import { currentRoute, initialRouterState, routerReducer, type Nav } from '../router'

export interface SettingsUi {
  open: boolean
  page: SettingsPage | null
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

  const back = useCallback(() => {
    if (query) setQuery('')
    else dispatch({ type: 'back' })
  }, [query])

  const goHome = useCallback(() => {
    setQuery('')
    dispatch({ type: 'reset', route: { name: 'home' } })
  }, [])

  const nav = useMemo<Nav>(
    () => ({
      route,
      canGoBack,
      back,
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
    [route, canGoBack, back, goHome],
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
  }
}
