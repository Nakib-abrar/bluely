import { Dialog as D } from 'radix-ui'
import { X } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from './cn'

export interface DialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  description?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  className?: string
  /** Hide the visual title (still announced to screen readers). */
  hideTitle?: boolean
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  className,
  hideTitle,
}: DialogProps) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-[60] bg-black/55 animate-fade-in" />
        <D.Content
          className={cn(
            'fixed top-1/2 left-1/2 z-[70] w-[min(480px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-line bg-panel p-5 shadow-panel animate-fade-in focus:outline-none',
            className,
          )}
        >
          <div className={cn('mb-3 pr-8', hideTitle && 'sr-only')}>
            <D.Title className="text-[16px] font-semibold text-fg">{title}</D.Title>
            {description ? (
              <D.Description className="mt-1 text-[13px] text-muted">{description}</D.Description>
            ) : null}
          </div>
          {!description && !hideTitle ? (
            <D.Description className="sr-only">{title}</D.Description>
          ) : null}
          {children}
          {footer ? <div className="mt-5 flex justify-end gap-2">{footer}</div> : null}
          <D.Close
            aria-label="Close"
            className="absolute top-4 right-4 inline-flex h-7 w-7 items-center justify-center rounded-lg text-muted hover:bg-panel-3 hover:text-fg"
          >
            <X size={16} />
          </D.Close>
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}

/** Large modal shell used for Settings (left nav + content), like a floating sheet. */
export function Sheet({
  open,
  onOpenChange,
  title,
  children,
  className,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  children: ReactNode
  className?: string
}) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/60 animate-fade-in" />
        <D.Content
          aria-describedby={undefined}
          className={cn(
            'fixed top-1/2 left-1/2 z-50 flex h-[min(640px,calc(100vh-48px))] w-[min(920px,calc(100vw-48px))] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-2xl border border-line bg-panel shadow-panel animate-fade-in focus:outline-none',
            className,
          )}
        >
          <D.Title className="sr-only">{title}</D.Title>
          {children}
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}

export const DialogClose = D.Close
