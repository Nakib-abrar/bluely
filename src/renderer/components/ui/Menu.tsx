import { DropdownMenu as M } from 'radix-ui'
import { ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from './cn'
import { Keys } from './Kbd'
import { Switch } from './Switch'

/** Dark dropdown menu used by the overlay "…" button and header menus. */
export function Menu({
  trigger,
  children,
  align = 'start',
  side = 'top',
  className,
}: {
  trigger: ReactNode
  children: ReactNode
  align?: 'start' | 'center' | 'end'
  side?: 'top' | 'bottom' | 'left' | 'right'
  className?: string
}) {
  return (
    <M.Root modal={false}>
      <M.Trigger asChild>{trigger}</M.Trigger>
      <M.Portal>
        <M.Content
          align={align}
          side={side}
          sideOffset={8}
          collisionPadding={8}
          className={cn(
            'z-50 min-w-[240px] rounded-xl border border-ov-line bg-panel-2 p-1.5 text-fg shadow-panel animate-fade-in',
            className,
          )}
        >
          {children}
        </M.Content>
      </M.Portal>
    </M.Root>
  )
}

const itemClass =
  'flex h-8 cursor-default select-none items-center gap-2.5 rounded-lg px-2 text-[13px] outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-panel-3'

export function MenuItem({
  icon,
  children,
  keys,
  onSelect,
  disabled,
}: {
  icon?: ReactNode
  children: ReactNode
  keys?: string[]
  onSelect?: () => void
  disabled?: boolean
}) {
  return (
    <M.Item className={itemClass} onSelect={onSelect} disabled={disabled}>
      {icon ? <span className="text-muted">{icon}</span> : null}
      <span className="flex-1 truncate">{children}</span>
      {keys?.length ? <Keys keys={keys} /> : null}
    </M.Item>
  )
}

export function MenuToggle({
  icon,
  children,
  checked,
  onCheckedChange,
}: {
  icon?: ReactNode
  children: ReactNode
  checked: boolean
  onCheckedChange: (v: boolean) => void
}) {
  return (
    <M.Item
      className={itemClass}
      onSelect={(e) => {
        e.preventDefault()
        onCheckedChange(!checked)
      }}
    >
      {icon ? <span className="text-muted">{icon}</span> : null}
      <span className="flex-1 truncate">{children}</span>
      <Switch
        checked={checked}
        onCheckedChange={onCheckedChange}
        label={String(children)}
        className="pointer-events-none scale-90"
      />
    </M.Item>
  )
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <M.Label className="px-2 pt-1 pb-1.5 text-[12px] font-medium text-subtle">{children}</M.Label>
  )
}

export function MenuSeparator() {
  return <M.Separator className="my-1.5 h-px bg-line" />
}

export function MenuSub({
  icon,
  label,
  children,
}: {
  icon?: ReactNode
  label: ReactNode
  children: ReactNode
}) {
  return (
    <M.Sub>
      <M.SubTrigger className={itemClass}>
        {icon ? <span className="text-muted">{icon}</span> : null}
        <span className="flex-1 truncate">{label}</span>
        <ChevronRight size={14} className="text-muted" />
      </M.SubTrigger>
      <M.Portal>
        <M.SubContent
          sideOffset={6}
          collisionPadding={8}
          className="z-50 min-w-[220px] rounded-xl border border-ov-line bg-panel-2 p-1.5 text-fg shadow-panel animate-fade-in"
        >
          {children}
        </M.SubContent>
      </M.Portal>
    </M.Sub>
  )
}

export function MenuRadioGroup({
  value,
  onValueChange,
  children,
}: {
  value: string
  onValueChange: (v: string) => void
  children: ReactNode
}) {
  return (
    <M.RadioGroup value={value} onValueChange={onValueChange}>
      {children}
    </M.RadioGroup>
  )
}

export function MenuRadioItem({
  value,
  children,
  icon,
}: {
  value: string
  children: ReactNode
  icon?: ReactNode
}) {
  return (
    <M.RadioItem value={value} className={cn(itemClass, 'pr-2')}>
      {icon ? <span className="w-5 text-center">{icon}</span> : null}
      <span className="flex-1 truncate">{children}</span>
      <M.ItemIndicator>
        <span className="h-1.5 w-1.5 rounded-full bg-accent-2" />
      </M.ItemIndicator>
    </M.RadioItem>
  )
}
