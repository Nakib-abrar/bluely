import type { ReactNode } from 'react'
import { cn } from './cn'

/** Settings row: icon tile, title + description, control on the right (matches the Settings layout). */
export function SettingsRow({
  icon,
  title,
  description,
  control,
  children,
  className,
}: {
  icon?: ReactNode
  title: ReactNode
  description?: ReactNode
  control?: ReactNode
  children?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('py-3', className)}>
      <div className="flex items-center gap-3.5">
        {icon ? (
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] border border-line bg-panel-2 text-muted">
            {icon}
          </div>
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-medium text-fg">{title}</div>
          {description ? (
            <div className="mt-0.5 text-[12.5px] text-muted">{description}</div>
          ) : null}
        </div>
        {control ? <div className="shrink-0">{control}</div> : null}
      </div>
      {children ? <div className="mt-3">{children}</div> : null}
    </div>
  )
}

export function SettingsSection({
  title,
  description,
  children,
  className,
}: {
  title: ReactNode
  description?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn('mt-6 first:mt-0', className)}>
      <h3 className="text-[15px] font-semibold text-fg">{title}</h3>
      {description ? <p className="mt-0.5 text-[12.5px] text-muted">{description}</p> : null}
      <div className="mt-2">{children}</div>
    </section>
  )
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('rounded-xl border border-line bg-panel-2 p-4', className)}>{children}</div>
  )
}
