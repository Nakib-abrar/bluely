import {
  forwardRef,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react'
import { cn } from './cn'

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  icon?: ReactNode
  right?: ReactNode
  invalid?: boolean
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { icon, right, invalid, className, ...rest },
  ref,
) {
  return (
    <div
      className={cn(
        'no-drag flex h-9 items-center gap-2 rounded-[10px] border bg-panel-2 px-3 text-[13.5px] transition-colors focus-within:border-accent',
        invalid ? 'border-danger' : 'border-line',
        className,
      )}
    >
      {icon ? <span className="text-subtle">{icon}</span> : null}
      <input
        ref={ref}
        className="h-full min-w-0 flex-1 bg-transparent text-fg outline-none placeholder:text-subtle focus-visible:outline-none"
        {...rest}
      />
      {right}
    </div>
  )
})

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }
>(function Textarea({ className, invalid, ...rest }, ref) {
  return (
    <textarea
      ref={ref}
      className={cn(
        'no-drag selectable w-full resize-y rounded-[10px] border bg-panel-2 px-3 py-2 text-[13.5px] leading-relaxed text-fg outline-none transition-colors placeholder:text-subtle focus:border-accent focus-visible:outline-none',
        invalid ? 'border-danger' : 'border-line',
        className,
      )}
      {...rest}
    />
  )
})

export function Label({
  children,
  htmlFor,
  className,
}: {
  children: ReactNode
  htmlFor?: string
  className?: string
}) {
  return (
    <label
      htmlFor={htmlFor}
      className={cn('mb-1.5 block text-[12.5px] font-medium text-muted', className)}
    >
      {children}
    </label>
  )
}
