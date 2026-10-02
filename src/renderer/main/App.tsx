import { useEffect, useState } from 'react'
import { ArrowLeft, Copy, Minus, RefreshCw, Search, Square, X } from 'lucide-react'
import { t } from '@shared/i18n'
import { Button, EmptyState, IconButton, Input, LogoMark, Wordmark } from '../components/ui'
import { invoke } from '../lib/ipc'
import { useIpcEvent } from '../hooks/useIpcEvent'

/** Foundation shell for the main window (title bar + header). Feature UI is added on top. */
export function App() {
  const [maximized, setMaximized] = useState(false)
  useEffect(() => {
    void invoke('window:isMaximized').then(setMaximized)
  }, [])
  useIpcEvent('window:maximized', setMaximized)

  return (
    <div className="flex h-full flex-col bg-bg">
      <header className="drag flex h-11 shrink-0 items-center gap-2 border-b border-line px-2">
        <IconButton label={t('common.back')} icon={<ArrowLeft size={16} />} disabled />
        <div className="flex flex-1 justify-center">
          <Input
            className="no-drag h-8 w-[min(440px,60vw)] rounded-lg bg-panel-2"
            icon={<Search size={14} />}
            placeholder="Search or ask anything…"
            aria-label={t('common.search')}
          />
        </div>
        <div className="no-drag flex items-center">
          <IconButton
            label={t('common.minimize')}
            icon={<Minus size={15} />}
            onClick={() => void invoke('window:minimize')}
          />
          <IconButton
            label={maximized ? t('common.restore') : t('common.maximize')}
            icon={maximized ? <Copy size={13} /> : <Square size={13} />}
            onClick={() => void invoke('window:toggleMaximize').then(setMaximized)}
          />
          <IconButton
            label={t('common.close')}
            icon={<X size={16} />}
            className="hover:bg-danger hover:text-white"
            onClick={() => void invoke('window:close')}
          />
        </div>
      </header>
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[920px] px-10 pt-8">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <LogoMark size={28} />
              <Wordmark className="text-[26px]" />
              <IconButton
                label="Refresh"
                icon={<RefreshCw size={15} />}
                shape="round"
                className="border border-line"
              />
            </div>
            <div className="flex flex-col items-center gap-1.5">
              <Button variant="primary" size="lg" icon={<LogoMark size={18} />} className="px-7">
                Start Bluely
              </Button>
            </div>
          </div>
          <EmptyState title="No meetings yet" description="Start Bluely when your call begins." />
        </div>
      </main>
    </div>
  )
}
