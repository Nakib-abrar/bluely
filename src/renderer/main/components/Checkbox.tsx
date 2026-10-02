import { Checkbox as C } from 'radix-ui'
import { Check } from 'lucide-react'

/** Round-cornered checkbox in the accent color (action items). */
export function Checkbox({
  id,
  checked,
  onCheckedChange,
  label,
}: {
  id?: string
  checked: boolean
  onCheckedChange(checked: boolean): void
  label?: string
}) {
  return (
    <C.Root
      id={id}
      checked={checked}
      aria-label={label}
      onCheckedChange={(v) => onCheckedChange(v === true)}
      className="no-drag flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] border border-line-strong bg-panel-2 transition-colors duration-150 hover:border-accent/60 data-[state=checked]:border-accent data-[state=checked]:bg-accent"
    >
      <C.Indicator className="text-white">
        <Check size={12} strokeWidth={3} />
      </C.Indicator>
    </C.Root>
  )
}
