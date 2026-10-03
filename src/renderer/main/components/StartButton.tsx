import { useState } from 'react'
import { t } from '@shared/i18n'
import { Button, cn, Spinner } from '../../components/ui'
import { formatElapsed } from '../../lib/format'
import { errorMessage, invoke, IpcError } from '../../lib/ipc'
import { useElapsed, useLiveSession } from '../hooks/useLiveSession'
import { useNav } from '../router'
import { toast } from '../stores/toast'
import { SparkGlyph } from './SparkGlyph'

const pill =
  'no-drag inline-flex h-11 min-w-[188px] shrink-0 select-none items-center justify-center gap-2.5 rounded-full border px-5 text-[15px] font-medium whitespace-nowrap transition-[background,border-color,color] duration-150'

/**
 * The big gradient "Start Bluely" pill. Turns into "Stop session" with an elapsed timer while
 * a call is starting or live (main treats 'starting' as live, and a start whose audio never
 * comes up must still be stoppable here). While the last call's notes are generated the next
 * call can already start, so Start stays usable with a "Generating notes…" line under it.
 */
export function StartButton({ className }: { className?: string }) {
  const live = useLiveSession()
  const nav = useNav()
  const [busy, setBusy] = useState(false)
  const status = live?.status ?? 'idle'
  const inCall = status === 'live' || status === 'starting'
  const elapsed = useElapsed(status === 'live' ? (live?.startedAt ?? null) : null)

  const start = () => {
    setBusy(true)
    invoke('session:start', {})
      .catch((err: unknown) => {
        if (err instanceof IpcError && (err.code === 'no_key' || err.ai?.code === 'no_key')) {
          nav.openSettings('models')
        }
        toast(`${t('home.header.startFailed')}: ${errorMessage(err)}`, 'error')
      })
      .finally(() => setBusy(false))
  }

  const stop = () => {
    setBusy(true)
    invoke('session:stop')
      .catch((err: unknown) =>
        toast(`${t('home.header.stopFailed')}: ${errorMessage(err)}`, 'error'),
      )
      .finally(() => setBusy(false))
  }

  if (inCall) {
    const detail = status === 'starting' ? t('home.header.starting') : formatElapsed(elapsed)
    const aria =
      status === 'starting'
        ? `${t('home.header.stop')} (${detail})`
        : `${t('home.header.stop')} (${t('home.header.liveElapsed', { elapsed: detail })})`
    return (
      <button
        type="button"
        onClick={stop}
        disabled={busy}
        aria-label={aria}
        className={cn(
          pill,
          'border-danger/40 bg-danger-soft text-fg hover:border-danger/70 disabled:opacity-60',
          className,
        )}
      >
        <span className="relative flex h-3 w-3 items-center justify-center" aria-hidden="true">
          <span className="animate-pulse-dot absolute h-3 w-3 rounded-full bg-danger/35" />
          <span className="h-[7px] w-[7px] rounded-[2px] bg-danger" />
        </span>
        <span>{t('home.header.stop')}</span>
        <span className="tabular text-[13.5px] text-muted">{detail}</span>
      </button>
    )
  }

  if (status === 'stopping') {
    return (
      <button
        type="button"
        disabled
        aria-busy="true"
        className={cn(pill, 'cursor-default border-line bg-panel-3 text-muted', className)}
      >
        <Spinner size={16} className="text-accent-2" />
        {t('home.header.stopping')}
      </button>
    )
  }

  const startButton = (
    <Button
      variant="primary"
      size="lg"
      loading={busy}
      onClick={start}
      icon={<SparkGlyph size={19} />}
      className={cn('min-w-[176px]', className)}
    >
      {t('home.header.start')}
    </Button>
  )

  if (status === 'processing') {
    return (
      <div className="flex flex-col items-center gap-1">
        {startButton}
        <span
          role="status"
          data-testid="start-processing"
          className="inline-flex h-4 items-center gap-1.5 text-[12px] text-muted"
        >
          <Spinner size={11} className="text-accent-2" />
          {t('home.header.generating')}
        </span>
      </div>
    )
  }

  return startButton
}
