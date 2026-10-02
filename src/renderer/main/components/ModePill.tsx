import { useState } from 'react'
import { DropdownMenu as M } from 'radix-ui'
import { Check, ChevronDown, SlidersHorizontal } from 'lucide-react'
import { t } from '@shared/i18n'
import { cn } from '../../components/ui'
import { errorMessage, invoke } from '../../lib/ipc'
import { useSettings } from '../../stores/settings'
import { useModes } from '../hooks/useModes'
import { useNav } from '../router'
import { toast } from '../stores/toast'

const itemClass =
  'flex h-9 cursor-default select-none items-center gap-2.5 rounded-lg px-2 text-[13px] text-fg outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-panel-3'

/** Header pill showing the active Mode (where Cluely has its "Detectable" toggle). */
export function ModePill() {
  const nav = useNav()
  const modes = useModes()
  const activeId = useSettings((s) => s.settings.activeModeId)
  const [optimistic, setOptimistic] = useState<string | null>(null)
  const currentId = optimistic ?? activeId
  const current = modes.find((m) => m.id === currentId) ?? modes[0]

  const choose = (id: string) => {
    if (id === currentId) return
    setOptimistic(id)
    invoke('modes:setActive', { id })
      .catch((err: unknown) =>
        toast(`${t('home.mode.changeFailed')}: ${errorMessage(err)}`, 'error'),
      )
      .finally(() => setOptimistic(null))
  }

  return (
    <M.Root modal={false}>
      <M.Trigger asChild>
        <button
          type="button"
          aria-label={t('home.mode.trigger', { name: current?.name ?? '' })}
          className="no-drag group inline-flex h-9 max-w-[260px] items-center gap-2 rounded-full border border-line bg-panel-2 pr-2.5 pl-3 text-[13.5px] font-medium text-fg transition-colors duration-150 hover:border-line-strong hover:bg-panel-3 data-[state=open]:border-line-strong data-[state=open]:bg-panel-3"
        >
          <span className="text-[14px] leading-none" aria-hidden="true">
            {current?.icon}
          </span>
          <span className="truncate">{current?.name}</span>
          <ChevronDown
            size={14}
            aria-hidden="true"
            className="shrink-0 text-muted transition-transform duration-150 group-data-[state=open]:rotate-180"
          />
        </button>
      </M.Trigger>
      <M.Portal>
        <M.Content
          side="bottom"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          className="z-50 max-h-[min(420px,var(--radix-dropdown-menu-content-available-height))] min-w-[260px] overflow-y-auto rounded-xl border border-line bg-panel-2 p-1.5 text-fg shadow-panel animate-fade-in"
        >
          <M.Label className="px-2 pt-1 pb-1.5 text-[12px] font-medium text-subtle">
            {t('home.mode.label')}
          </M.Label>
          <M.RadioGroup value={currentId} onValueChange={choose}>
            {modes.map((m) => (
              <M.RadioItem key={m.id} value={m.id} className={itemClass}>
                <span className="w-5 text-center text-[14px]" aria-hidden="true">
                  {m.icon}
                </span>
                <span className={cn('flex-1 truncate', m.id === currentId && 'font-medium')}>
                  {m.name}
                </span>
                <M.ItemIndicator>
                  <Check size={15} className="text-accent-text" />
                </M.ItemIndicator>
              </M.RadioItem>
            ))}
          </M.RadioGroup>
          <M.Separator className="my-1.5 h-px bg-line" />
          <M.Item className={itemClass} onSelect={() => nav.openSettings('modes')}>
            <span className="flex w-5 justify-center text-muted">
              <SlidersHorizontal size={14} />
            </span>
            <span className="flex-1 truncate text-muted">{t('home.mode.manage')}</span>
          </M.Item>
        </M.Content>
      </M.Portal>
    </M.Root>
  )
}
