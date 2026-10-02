import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from './cn'

export type BannerTone = 'info' | 'warning' | 'success' | 'error'

const toneClass: Record<BannerTone, string> = {
  info: 'border-accent/25 bg-accent-soft',
  warning: 'border-warning/30 bg-warning-soft',
  success: 'border-success/30 bg-success-soft',
  error: 'border-danger/30 bg-danger-soft',
}
const toneIcon: Record<BannerTone, ReactNode> = {
  info: <Info size={16} className="text-accent-text" />,
  warning: <AlertTriangle size={16} className="text-warning" />,
  success: <CheckCircle2 size={16} className="text-success" />,
  error: <XCircle size={16} className="text-danger" />,
}

export function Banner({
  tone = 'info',
  title,
  children,
  action,
  onDismiss,
  className,
}: {
  tone?: BannerTone
  title: ReactNode
  children?: ReactNode
  action?: ReactNode
  onDismiss?: () => void
  className?: string
}) {
  return (
    <div
      role={tone === 'error' || tone === 'warning' ? 'alert' : 'status'}
      className={cn(
        'flex items-start gap-3 rounded-xl border px-3.5 py-2.5 animate-fade-in',
        toneClass[tone],
        className,
      )}
    >
      <span className="mt-0.5">{toneIcon[tone]}</span>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-fg">{title}</div>
        {children ? <div className="mt-0.5 text-[12.5px] text-muted">{children}</div> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
      {onDismiss ? (
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onDismiss}
          className="no-drag -mr-1 inline-flex h-6 w-6 items-center justify-center rounded-md text-muted hover:bg-panel-3 hover:text-fg"
        >
          <X size={14} />
        </button>
      ) : null}
    </div>
  )
}
