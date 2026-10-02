import { AlertTriangle } from 'lucide-react'
import { t } from '@shared/i18n'
import { cn } from '../../components/ui'
import { useSettings } from '../../stores/settings'
import { useKeyHealth } from '../hooks/useKeyHealth'
import { shortModelId } from '../lib/text'
import { useNav } from '../router'

/** Line under the Start button: active model + OpenRouter connection, or what to fix. */
export function KeySubtitle({ className }: { className?: string }) {
  const nav = useNav()
  const status = useKeyHealth((s) => s.status)
  const check = useKeyHealth((s) => s.check)
  const error = useKeyHealth((s) => s.error)
  const model = useSettings((s) => s.settings.models.smart.model)
  const base = 'flex h-5 max-w-[300px] items-center justify-center gap-1.5 text-[12px]'

  if (!status) {
    if (check === 'error' && error) {
      return (
        <div className={cn(base, 'text-warning', className)} title={error}>
          <span className="truncate">{error}</span>
        </div>
      )
    }
    return <div className={cn(base, 'text-subtle', className)}>{t('home.header.checking')}</div>
  }

  if (!status.hasKey) {
    return (
      <button
        type="button"
        onClick={() => nav.openSettings('models')}
        className={cn(
          base,
          'no-drag rounded-md px-1.5 font-medium text-warning underline-offset-2 hover:underline',
          className,
        )}
      >
        <AlertTriangle size={12.5} aria-hidden="true" />
        {t('home.header.addKey')}
      </button>
    )
  }

  if (check === 'error') {
    return (
      <button
        type="button"
        onClick={() => nav.openSettings('models')}
        title={error ?? undefined}
        className={cn(
          base,
          'no-drag rounded-md px-1.5 text-warning underline-offset-2 hover:underline',
          className,
        )}
      >
        <AlertTriangle size={12.5} className="shrink-0" aria-hidden="true" />
        <span className="truncate">{error ?? t('home.header.checkFailed')}</span>
      </button>
    )
  }

  return (
    <div className={cn(base, 'text-subtle', className)} aria-live="polite">
      <span className="truncate font-medium text-muted">{shortModelId(model)}</span>
      <span aria-hidden="true">·</span>
      {check === 'ok' ? (
        <>
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success shadow-[0_0_0_3px_var(--success-soft)]" />
          <span className="whitespace-nowrap">{t('home.header.connected')}</span>
        </>
      ) : (
        <span className="whitespace-nowrap">{t('home.header.checking')}</span>
      )}
    </div>
  )
}
