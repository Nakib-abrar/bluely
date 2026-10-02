import { Select as S } from 'radix-ui'
import { Check, ChevronDown } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from './cn'

export interface SelectOption<V extends string> {
  value: V
  label: ReactNode
  description?: ReactNode
  disabled?: boolean
}

export interface SelectProps<V extends string> {
  value: V
  onValueChange: (value: V) => void
  options: SelectOption<V>[]
  label: string
  placeholder?: string
  className?: string
  disabled?: boolean
  size?: 'sm' | 'md'
}

export function Select<V extends string>({
  value,
  onValueChange,
  options,
  label,
  placeholder,
  className,
  disabled,
  size = 'md',
}: SelectProps<V>) {
  return (
    <S.Root value={value} onValueChange={(v) => onValueChange(v as V)} disabled={disabled}>
      <S.Trigger
        aria-label={label}
        className={cn(
          'no-drag inline-flex items-center justify-between gap-2 rounded-[10px] border border-line bg-panel-2 text-fg transition-colors hover:bg-panel-3 data-[placeholder]:text-subtle disabled:opacity-50',
          size === 'sm' ? 'h-8 px-2.5 text-[12.5px]' : 'h-9 px-3 text-[13.5px]',
          className,
        )}
      >
        <span className="truncate">
          <S.Value placeholder={placeholder} />
        </span>
        <S.Icon>
          <ChevronDown size={15} className="text-muted" />
        </S.Icon>
      </S.Trigger>
      <S.Portal>
        <S.Content
          position="popper"
          sideOffset={6}
          className="z-50 max-h-[min(360px,var(--radix-select-content-available-height))] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-xl border border-line bg-panel-2 p-1 shadow-panel animate-fade-in"
        >
          <S.Viewport>
            {options.map((o) => (
              <S.Item
                key={o.value}
                value={o.value}
                disabled={o.disabled}
                className="relative flex cursor-default select-none items-start gap-2 rounded-lg py-1.5 pr-2 pl-7 text-[13px] text-fg outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-panel-3"
              >
                <S.ItemIndicator className="absolute top-2 left-2">
                  <Check size={14} className="text-accent-text" />
                </S.ItemIndicator>
                <div className="min-w-0">
                  <S.ItemText>{o.label}</S.ItemText>
                  {o.description ? (
                    <div className="text-[11.5px] text-subtle">{o.description}</div>
                  ) : null}
                </div>
              </S.Item>
            ))}
          </S.Viewport>
        </S.Content>
      </S.Portal>
    </S.Root>
  )
}
