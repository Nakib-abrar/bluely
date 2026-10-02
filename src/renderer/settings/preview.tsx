/**
 * Dev-only preview page for the Settings sheet and onboarding (built only with BLUELY_PREVIEW=1,
 * used by tests/e2e/settingsui.spec.ts). Routes by hash:
 *   #settings/<page>  open the sheet on a page      #settings-closed  sheet closed
 *   #onboarding       first-run onboarding          #done             onboarding finished
 */
import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../styles/globals.css'
import { t } from '@shared/i18n'
import { settingsPageSchema } from '@shared/ipc'
import type { SettingsPage } from '@shared/types'
import { Button, TooltipProvider, Wordmark } from '../components/ui'
import { initSettingsSync } from '../stores/settings'
import { Onboarding, SettingsSheet } from './index'

type Route =
  | { kind: 'settings'; open: boolean; page: SettingsPage | null }
  | { kind: 'onboarding' }
  | { kind: 'done' }

function parseHash(hash: string): Route {
  const value = hash.replace(/^#/, '')
  if (value === 'onboarding') return { kind: 'onboarding' }
  if (value === 'done') return { kind: 'done' }
  if (value === 'settings-closed') return { kind: 'settings', open: false, page: null }
  const page = settingsPageSchema.safeParse(value.split('/')[1])
  return { kind: 'settings', open: true, page: page.success ? page.data : null }
}

export function Preview() {
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash))
  useEffect(() => {
    const onHash = () => setRoute(parseHash(location.hash))
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  if (route.kind === 'onboarding') {
    return <Onboarding onDone={() => (location.hash = '#done')} />
  }
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-4 bg-bg"
      data-testid="preview-home"
    >
      <Wordmark className="text-[28px]" />
      {route.kind === 'done' ? <p data-testid="onboarding-done">{t('common.done')}</p> : null}
      <Button variant="primary" onClick={() => (location.hash = '#settings/general')}>
        {t('common.settings')}
      </Button>
      {route.kind === 'settings' ? (
        <SettingsSheet
          open={route.open}
          page={route.page}
          onOpenChange={(open) => {
            if (!open) location.hash = '#settings-closed'
          }}
          onNavigate={(page) => (location.hash = `#settings/${page}`)}
        />
      ) : null}
    </div>
  )
}

void initSettingsSync().finally(() => {
  createRoot(document.getElementById('root') as HTMLElement).render(
    <StrictMode>
      <TooltipProvider>
        <Preview />
      </TooltipProvider>
    </StrictMode>,
  )
})
