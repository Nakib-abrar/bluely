import type { ReactNode } from 'react'
import { cn } from './cn'

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn('flex flex-col items-center justify-center px-6 py-14 text-center', className)}
    >
      {icon ? <div className="mb-4 text-subtle">{icon}</div> : null}
      <div className="text-[15px] font-semibold text-fg">{title}</div>
      {description ? (
        <div className="mt-1.5 max-w-[420px] text-[13px] text-muted">{description}</div>
      ) : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  )
}
