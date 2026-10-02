import type { ReactNode } from 'react'
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react'
import { t } from '@shared/i18n'
import { useToasts, type ToastTone } from '../stores/toast'

const icons: Record<ToastTone, ReactNode> = {
  neutral: <Info size={15} className="shrink-0 text-accent-text" />,
  success: <CheckCircle2 size={15} className="shrink-0 text-success" />,
  error: <AlertCircle size={15} className="shrink-0 text-danger" />,
}

/** Bottom-centered transient messages ("Saved to …", "Copied as Markdown", errors). */
export function Toaster() {
  const toasts = useToasts((s) => s.toasts)
  const dismiss = useToasts((s) => s.dismiss)
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-6 z-[60] flex flex-col items-center gap-2 px-6"
    >
      {toasts.map((x) => (
        <div
          key={x.id}
          role={x.tone === 'error' ? 'alert' : 'status'}
          data-testid="toast"
          className="pointer-events-auto flex max-w-[560px] items-start gap-2.5 rounded-xl border border-line-strong bg-panel-2 py-2.5 pr-2 pl-3.5 text-[13px] text-fg shadow-panel animate-fade-in"
        >
          <span className="pt-px">{icons[x.tone]}</span>
          <span className="min-w-0 flex-1 break-words">{x.message}</span>
          <button
            type="button"
            aria-label={t('common.close')}
            onClick={() => dismiss(x.id)}
            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-subtle hover:text-fg"
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  )
}
