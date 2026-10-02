import { Switch as S } from 'radix-ui'
import { cn } from './cn'

export interface SwitchProps {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  label: string
  className?: string
  id?: string
}

export function Switch({ checked, onCheckedChange, disabled, label, className, id }: SwitchProps) {
  return (
    <S.Root
      id={id}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={label}
      className={cn(
        'no-drag relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full border border-line transition-colors duration-150 disabled:opacity-50',
        checked ? 'bg-accent' : 'bg-panel-4',
        className,
      )}
    >
      <S.Thumb className="block h-[16px] w-[16px] translate-x-[3px] rounded-full bg-white shadow-soft transition-transform duration-150 data-[state=checked]:translate-x-[18px]" />
    </S.Root>
  )
}
