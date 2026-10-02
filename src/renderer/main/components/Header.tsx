import { useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { t } from '@shared/i18n'
import { cn, IconButton, Wordmark } from '../../components/ui'
import { useKeyHealth } from '../hooks/useKeyHealth'
import { refetchLiveSession } from '../hooks/useLiveSession'
import { useRefresh } from '../stores/refresh'
import { KeySubtitle } from './KeySubtitle'
import { ModePill } from './ModePill'
import { Notices } from './Notices'
import { StartButton } from './StartButton'
import { UpcomingMeetingsSlot } from './UpcomingMeetingsSlot'

function RefreshButton() {
  const bump = useRefresh((s) => s.bump)
  const [spinning, setSpinning] = useState(false)
  return (
    <IconButton
      label={t('home.header.refresh')}
      shape="round"
      className="border border-line"
      icon={
        <RefreshCw
          size={15}
          className={cn(spinning && 'animate-spin-slow')}
          onAnimationIteration={() => setSpinning(false)}
          onAnimationEnd={() => setSpinning(false)}
        />
      }
      onClick={() => {
        setSpinning(true)
        bump()
        void refetchLiveSession()
        void useKeyHealth.getState().refresh({ retest: true })
      }}
    />
  )
}

/** Home header: wordmark, refresh, mode pill, Start button with status line, notices. */
export function Header() {
  return (
    <section className="border-b border-line bg-panel">
      <div className="mx-auto max-w-[920px] px-10 pt-6 pb-7">
        <div className="flex items-start justify-between gap-6">
          <div className="flex h-11 min-w-0 items-center gap-3">
            <Wordmark className="mr-1 text-[27px] leading-none" />
            <RefreshButton />
            <ModePill />
          </div>
          <div className="flex shrink-0 flex-col items-center gap-1.5">
            <StartButton />
            <KeySubtitle />
          </div>
        </div>
        <Notices />
        <UpcomingMeetingsSlot />
      </div>
    </section>
  )
}
