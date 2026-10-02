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
 * The big gradient "Start Bluely" pill. Turns into "Stop session" with an elapsed timer
 * while live, and a disabled "Generating notes…" while post-call processing runs.
 */
export function StartButton({ className }: { className?: string }) {
  const live = useLiveSession()
  const nav = useNav()
  const [busy, setBusy] = useState(false)
  const status = live?.status ?? 'idle'
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

  if (status === 'live') {
    const time = formatElapsed(elapsed)
    return (
      <button
        type="button"
        onClick={stop}
        disabled={busy}
        aria-label={`${t('home.header.stop')} (${t('home.header.liveElapsed', { elapsed: time })})`}
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
        <span className="tabular text-[13.5px] text-muted">{time}</span>
      </button>
    )
  }

  if (status === 'processing' || status === 'stopping' || status === 'starting') {
    const label =
      status === 'processing'
        ? t('home.header.generating')
        : status === 'stopping'
          ? t('home.header.stopping')
          : t('home.header.starting')
    return (
      <button
        type="button"
        disabled
        aria-busy="true"
        className={cn(pill, 'cursor-default border-line bg-panel-3 text-muted', className)}
      >
        <Spinner size={16} className="text-accent-2" />
        {label}
      </button>
    )
  }

  return (
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
}
