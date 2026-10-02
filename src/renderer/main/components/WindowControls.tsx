import { useEffect, useState } from 'react'
import { t } from '@shared/i18n'
import { cn } from '../../components/ui'
import { invoke } from '../../lib/ipc'
import { useIpcEvent } from '../../hooks/useIpcEvent'

const base =
  'no-drag inline-flex h-11 w-[46px] items-center justify-center text-muted transition-colors duration-150 hover:text-fg focus-visible:-outline-offset-2'

/** Windows-style caption buttons; thin 10 px glyphs drawn to match native ones. */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false)
  useEffect(() => {
    invoke('window:isMaximized')
      .then(setMaximized)
      .catch(() => undefined)
  }, [])
  useIpcEvent('window:maximized', setMaximized)

  return (
    <div className="flex items-stretch" role="group" aria-label={t('home.titleBar.windowControls')}>
      <button
        type="button"
        aria-label={t('common.minimize')}
        title={t('common.minimize')}
        className={cn(base, 'hover:bg-panel-3')}
        onClick={() => void invoke('window:minimize').catch(() => undefined)}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 5.5h10" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
      <button
        type="button"
        aria-label={maximized ? t('common.restore') : t('common.maximize')}
        title={maximized ? t('common.restore') : t('common.maximize')}
        className={cn(base, 'hover:bg-panel-3')}
        onClick={() =>
          void invoke('window:toggleMaximize')
            .then(setMaximized)
            .catch(() => undefined)
        }
      >
        {maximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
            <path d="M2.5 2.5V.5h7v7h-2" stroke="currentColor" strokeWidth="1" />
            <rect x=".5" y="2.5" width="7" height="7" stroke="currentColor" strokeWidth="1" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
            <rect x=".5" y=".5" width="9" height="9" stroke="currentColor" strokeWidth="1" />
          </svg>
        )}
      </button>
      <button
        type="button"
        aria-label={t('common.close')}
        title={t('common.close')}
        className={cn(base, 'hover:bg-danger hover:text-white active:brightness-90')}
        onClick={() => void invoke('window:close').catch(() => undefined)}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M.5.5l9 9M9.5.5l-9 9" stroke="currentColor" strokeWidth="1.1" />
        </svg>
      </button>
    </div>
  )
}
