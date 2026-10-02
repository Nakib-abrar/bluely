import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { cn } from './cn'
import { Tooltip } from './Tooltip'

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  icon: ReactNode
  size?: 'sm' | 'md' | 'lg'
  shape?: 'square' | 'round'
  tooltip?: boolean
  active?: boolean
}

const sizes = { sm: 'h-7 w-7', md: 'h-8 w-8', lg: 'h-10 w-10' }

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    label,
    icon,
    size = 'md',
    shape = 'square',
    tooltip = true,
    active,
    className,
    type = 'button',
    ...rest
  },
  ref,
) {
  const button = (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      className={cn(
        'no-drag inline-flex shrink-0 items-center justify-center text-muted transition-colors duration-150 hover:bg-panel-3 hover:text-fg disabled:opacity-40',
        shape === 'round' ? 'rounded-full' : 'rounded-lg',
        active && 'bg-panel-3 text-fg',
        sizes[size],
        className,
      )}
      {...rest}
    >
      {icon}
    </button>
  )
  return tooltip ? <Tooltip content={label}>{button}</Tooltip> : button
})
