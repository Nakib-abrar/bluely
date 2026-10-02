import { useCallback, useEffect, useRef } from 'react'
import { cn } from '../components/ui'
import { useSettings } from '../stores/settings'
import { HomePage } from './components/HomePage'
import { SearchResults, type SearchResultsHandle } from './components/SearchResults'
import { SessionPage } from './components/SessionPage'
import { TitleBar } from './components/TitleBar'
import { Toaster } from './components/Toaster'
import { WindowControls } from './components/WindowControls'
import { initAiStream } from './hooks/useAiStream'
import { useGlobalShortcuts } from './hooks/useGlobalShortcuts'
import { useKeyHealth } from './hooks/useKeyHealth'
import { initLiveSession } from './hooks/useLiveSession'
import { useMainNav } from './hooks/useMainNav'
import { useSearch } from './hooks/useSearch'
import { NavContext } from './router'
import { Onboarding, SettingsSheet } from './slots'

/** Inactive layers stay mounted (scroll position, drafts) but invisible and unfocusable. */
function layer(active: boolean): string {
  return cn('absolute inset-0', !active && 'invisible pointer-events-none')
}

/** Main window: composes the title bar, router pages, search, settings and onboarding. */
export function App() {
  const onboardingComplete = useSettings((s) => s.settings.general.onboardingComplete)
  const m = useMainNav()
  const search = useSearch(m.query)
  const searchRef = useRef<HTMLInputElement>(null)
  const resultsRef = useRef<SearchResultsHandle>(null)

  useEffect(() => {
    initAiStream()
    initLiveSession()
    void useKeyHealth.getState().refresh()
  }, [])

  const focusSearch = useCallback(() => {
    searchRef.current?.focus()
    searchRef.current?.select()
  }, [])
  useGlobalShortcuts({ focusSearch, back: m.nav.back })

  const settingsSheet = (
    <SettingsSheet
      open={m.settingsUi.open}
      page={m.settingsUi.page}
      onOpenChange={(open) => {
        m.setSettingsOpen(open)
        // The key may have been added or changed in Settings.
        if (!open) void useKeyHealth.getState().refresh()
      }}
      onNavigate={m.setSettingsPage}
    />
  )

  if (!onboardingComplete || m.route.name === 'onboarding') {
    const done = () => {
      void useSettings
        .getState()
        .update({ general: { onboardingComplete: true } })
        .catch(() => undefined)
      m.goHome()
      void useKeyHealth.getState().refresh()
    }
    return (
      <NavContext.Provider value={m.nav}>
        <div className="flex h-full flex-col bg-bg">
          {/* Frameless window: keep it movable and closable during onboarding. */}
          <div className="drag flex h-11 shrink-0 justify-end">
            <WindowControls />
          </div>
          <div className="min-h-0 flex-1">
            <Onboarding onDone={done} />
          </div>
        </div>
        {settingsSheet}
        <Toaster />
      </NavContext.Provider>
    )
  }

  const { route, searching } = m
  return (
    <NavContext.Provider value={m.nav}>
      <div className="flex h-full flex-col bg-bg">
        <TitleBar
          ref={searchRef}
          query={m.query}
          onQueryChange={m.setQuery}
          onSubmit={() => resultsRef.current?.submit()}
          searching={search.loading}
          canGoBack={m.nav.canGoBack}
          onBack={m.nav.back}
        />
        <main className="relative min-h-0 flex-1">
          <div className={layer(!searching && route.name === 'home')}>
            <HomePage />
          </div>
          {route.name === 'session' ? (
            <div className={layer(!searching)}>
              <SessionPage
                key={route.sessionId}
                sessionId={route.sessionId}
                tab={route.tab ?? 'notes'}
              />
            </div>
          ) : null}
          {searching ? (
            <div className={cn(layer(true), 'bg-bg')}>
              <SearchResults
                ref={resultsRef}
                query={m.query}
                view={search}
                onOpenSession={m.nav.openSession}
                onFocusSearch={() => searchRef.current?.focus()}
                onExit={() => {
                  m.setQuery('')
                  searchRef.current?.focus()
                }}
              />
            </div>
          ) : null}
        </main>
      </div>
      {settingsSheet}
      <Toaster />
    </NavContext.Provider>
  )
}
