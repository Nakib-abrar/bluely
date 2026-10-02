import { Tabs as T } from 'radix-ui'
import type { ReactNode } from 'react'
import { cn } from './cn'

export interface TabItem<V extends string> {
  value: V
  label: ReactNode
  badge?: ReactNode
}

export function TabList<V extends string>({
  items,
  className,
  variant = 'underline',
}: {
  items: TabItem<V>[]
  className?: string
  variant?: 'underline' | 'pill'
}) {
  return (
    <T.List
      className={cn(
        'flex items-center',
        variant === 'underline' ? 'gap-5 border-b border-line' : 'gap-1 rounded-xl bg-panel-2 p-1',
        className,
      )}
    >
      {items.map((it) => (
        <T.Trigger
          key={it.value}
          value={it.value}
          className={cn(
            'no-drag inline-flex items-center gap-1.5 text-[13px] font-medium text-muted transition-colors hover:text-fg',
            variant === 'underline'
              ? '-mb-px border-b-2 border-transparent pt-1 pb-2.5 data-[state=active]:border-accent data-[state=active]:text-fg'
              : 'h-7 rounded-lg px-3 data-[state=active]:bg-panel-4 data-[state=active]:text-fg',
          )}
        >
          {it.label}
          {it.badge}
        </T.Trigger>
      ))}
    </T.List>
  )
}

export const TabsRoot = T.Root
export const TabsContent = T.Content
