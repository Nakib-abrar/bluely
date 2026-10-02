import { cn } from './cn'

export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-[20px] min-w-[20px] items-center justify-center rounded-[5px] border border-line-strong bg-panel-3 px-1.5 font-sans text-[11px] font-medium text-fg',
        className,
      )}
    >
      {children}
    </kbd>
  )
}

/** Renders keycaps for a list of keys, e.g. ["Ctrl", "↵"]. */
export function Keys({ keys, className }: { keys: string[]; className?: string }) {
  if (!keys.length) return null
  return (
    <span className={cn('inline-flex items-center gap-1', className)}>
      {keys.map((k, i) => (
        <Kbd key={`${k}-${i}`}>{k}</Kbd>
      ))}
    </span>
  )
}
