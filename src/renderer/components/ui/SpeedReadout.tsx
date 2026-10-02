import type { SpeedStats } from '@shared/types'
import { formatSpeed } from '../../lib/speed'
import { cn } from './cn'

export function SpeedReadout({ stats, className }: { stats: SpeedStats; className?: string }) {
  const cost =
    stats.costUsd != null
      ? ` · $${stats.costUsd < 0.01 ? stats.costUsd.toFixed(4) : stats.costUsd.toFixed(3)}`
      : ''
  return (
    <div
      className={cn('tabular truncate text-[11.5px] text-subtle', className)}
      title={`${formatSpeed(stats)}${cost}`}
    >
      {formatSpeed(stats)}
    </div>
  )
}
