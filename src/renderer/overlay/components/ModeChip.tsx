import { ChevronDown } from 'lucide-react'
import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { t } from '@shared/i18n'
import type { Mode } from '@shared/types'
import { Menu, MenuLabel, MenuRadioGroup, MenuRadioItem } from '../../components/ui'
import { setActiveMode } from '../actions'
import { useActiveMode } from '../hooks/useActiveMode'

/** Radio items for choosing the active mode (shared by the header chip and the "…" menu). */
export function ModeRadioItems({ modes, activeId }: { modes: Mode[]; activeId: string }) {
  return (
    <MenuRadioGroup value={activeId} onValueChange={setActiveMode}>
      {modes.map((m) => (
        <MenuRadioItem key={m.id} value={m.id} icon={m.icon}>
          {/* Capped so the submenu fits beside the "…" menu in the narrow overlay window. */}
          <span className="block max-w-[150px] truncate" title={m.name}>
            {m.name}
          </span>
        </MenuRadioItem>
      ))}
    </MenuRadioGroup>
  )
}

const ChipButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { mode: Mode | undefined }
>(function ChipButton({ mode, className: _className, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      title={mode ? t('overlay.panel.modeTip', { name: mode.name }) : t('overlay.panel.mode')}
      className="no-drag inline-flex h-7 max-w-[190px] items-center gap-1.5 rounded-full border border-line px-2.5 text-[12.5px] font-medium text-muted transition-colors duration-150 hover:bg-panel-3 hover:text-fg data-[state=open]:bg-panel-3 data-[state=open]:text-fg"
      {...rest}
    >
      <span aria-hidden className="text-[13px] leading-none">
        {mode?.icon}
      </span>
      <span className="truncate">{mode?.name ?? t('overlay.panel.mode')}</span>
      <ChevronDown size={13} className="shrink-0 opacity-70" />
    </button>
  )
})

/** Header chip showing the active mode; opens a list to switch modes mid-call. */
export function ModeChip() {
  const { modes, active, activeId } = useActiveMode()
  return (
    <Menu trigger={<ChipButton mode={active} />} side="bottom" align="end">
      <MenuLabel>{t('overlay.menu.modes')}</MenuLabel>
      <ModeRadioItems modes={modes} activeId={activeId} />
    </Menu>
  )
}
