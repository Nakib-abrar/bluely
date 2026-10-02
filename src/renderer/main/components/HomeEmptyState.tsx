import { KeyRound } from 'lucide-react'
import { t } from '@shared/i18n'
import { Button, LogoMark } from '../../components/ui'
import { useKeyHealth } from '../hooks/useKeyHealth'
import { useNav } from '../router'
import { StartButton } from './StartButton'

/** First-run state of the history list. */
export function HomeEmptyState() {
  const nav = useNav()
  const status = useKeyHealth((s) => s.status)
  const noKey = status !== null && !status.hasKey

  return (
    <div
      className="flex flex-col items-center px-6 pt-14 pb-10 text-center"
      data-testid="home-empty"
    >
      <div className="relative mb-6">
        <div aria-hidden="true" className="absolute inset-1 rounded-full bg-accent/45 blur-xl" />
        <LogoMark size={60} className="relative" />
      </div>
      <h2 className="text-[18px] font-semibold tracking-[-0.01em] text-fg">
        {t('home.empty.title')}
      </h2>
      <p className="mt-2 max-w-[460px] text-[13.5px] leading-relaxed text-muted">
        {t('home.empty.body')}
      </p>
      <div className="mt-7">
        <StartButton />
      </div>
      {noKey ? (
        <div className="mt-6 flex flex-col items-center gap-2.5 rounded-xl border border-warning/25 bg-warning-soft px-5 py-3.5">
          <p className="text-[12.5px] text-muted">{t('home.empty.keyHint')}</p>
          <Button
            size="sm"
            variant="secondary"
            icon={<KeyRound size={13} />}
            onClick={() => nav.openSettings('models')}
          >
            {t('home.empty.addKey')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
