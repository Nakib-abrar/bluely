import { useEffect, useRef } from 'react'
import { t } from '@shared/i18n'
import type { Channel, ChannelState } from '@shared/types'
import { cn } from '../../components/ui'
import type { CaptureLevels, CaptureLike } from '../capture'
import { levelToScale } from '../lib/levels'

/** Level updates are applied at most this often (the meters are tiny; 15 Hz is plenty). */
const MAX_HZ = 15

const stateKey = {
  listening: 'overlay.pill.channelListening',
  starting: 'overlay.pill.channelStarting',
  off: 'overlay.pill.channelOff',
  error: 'overlay.pill.channelError',
} as const

function Meter({
  who,
  state,
  barRef,
}: {
  who: Channel
  state: ChannelState
  barRef: (el: HTMLSpanElement | null) => void
}) {
  const label = who === 'me' ? t('common.me') : t('common.them')
  return (
    <span
      className="ov-meter flex items-center gap-1"
      data-state={state}
      title={t(stateKey[state], { who: label })}
    >
      <span className="ov-meter-label text-[10.5px] font-medium tracking-wide">{label}</span>
      <span className="relative h-3 w-[3px] overflow-hidden rounded-full bg-fg/15">
        <span
          ref={barRef}
          className="ov-meter-fill absolute inset-0 rounded-full"
          style={{ transform: 'scaleY(0)' }}
        />
      </span>
    </span>
  )
}

/**
 * The pill's tiny "Me / Them" activity indicator. Levels are written straight to the DOM
 * (CSS transform only) so audio updates never re-render React.
 */
export function ActivityMeter({
  capture,
  audio,
  className,
}: {
  capture: CaptureLike
  audio: Record<Channel, { state: ChannelState }>
  className?: string
}) {
  const bars = useRef<Record<Channel, HTMLSpanElement | null>>({ me: null, them: null })

  useEffect(() => {
    let last = 0
    let latest: CaptureLevels | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    const apply = () => {
      timer = null
      last = performance.now()
      if (!latest) return
      for (const who of ['me', 'them'] as const) {
        const bar = bars.current[who]
        const level = latest[who]
        if (!bar) continue
        bar.style.transform = `scaleY(${levelToScale(level.rms).toFixed(3)})`
        bar.parentElement?.parentElement?.setAttribute('data-speaking', String(level.speaking))
      }
    }
    const unsubscribe = capture.subscribe((levels) => {
      latest = levels
      if (timer) return
      const wait = Math.max(0, 1000 / MAX_HZ - (performance.now() - last))
      timer = setTimeout(apply, wait)
    })
    return () => {
      unsubscribe()
      if (timer) clearTimeout(timer)
    }
  }, [capture])

  return (
    <span
      role="img"
      aria-label={t('overlay.pill.activity')}
      className={cn('flex items-center gap-2', className)}
    >
      <Meter
        who="me"
        state={audio.me.state}
        barRef={(el) => {
          bars.current.me = el
        }}
      />
      <Meter
        who="them"
        state={audio.them.state}
        barRef={(el) => {
          bars.current.them = el
        }}
      />
    </span>
  )
}
