import type { ReactNode } from 'react'
import { Spinner } from '../../components/ui'

/** Centered empty state used inside the session tabs. */
export function TabEmpty({
  icon,
  title,
  body,
  action,
}: {
  icon: ReactNode
  title: string
  body?: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center px-6 py-16 text-center">
      <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl border border-line bg-panel text-subtle">
        {icon}
      </div>
      <div className="text-[15px] font-semibold text-fg">{title}</div>
      {body ? <div className="mt-1.5 max-w-[400px] text-[13px] text-muted">{body}</div> : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  )
}

/** Skeleton paragraph + status line while post-call processing writes this tab. */
export function TabGenerating({ label }: { label: string }) {
  return (
    <div className="py-2" aria-busy="true">
      <div className="mb-5 flex items-center gap-2 text-[13px] text-muted" role="status">
        <Spinner size={14} className="text-accent-2" />
        {label}
      </div>
      <div className="space-y-2.5" aria-hidden="true">
        {[92, 84, 88, 60].map((w, i) => (
          <div
            key={i}
            className="animate-pulse-dot h-3 rounded bg-panel-2"
            style={{ width: `${w}%`, animationDelay: `${i * 120}ms` }}
          />
        ))}
      </div>
    </div>
  )
}

/** Small uppercase section label (Summary, Key points, …). */
export function SectionLabel({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-2.5 flex items-center justify-between gap-3">
      <h3 className="text-[11.5px] font-semibold tracking-[0.06em] text-subtle uppercase">
        {children}
      </h3>
      {right}
    </div>
  )
}
