import {
  Ellipsis,
  MessageCircle,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Users,
  WandSparkles,
  type LucideIcon,
} from 'lucide-react'
import { forwardRef, Fragment, type ButtonHTMLAttributes } from 'react'
import { t, type MessageKey } from '@shared/i18n'
import { keybindDisplay, type KeybindId } from '@shared/keybinds'
import type { ActionKind } from '@shared/types'
import { cn, Keys, Menu, MenuItem, Tooltip } from '../../components/ui'
import { useSettings } from '../../stores/settings'
import { runAction } from '../actions'

interface ActionDef {
  kind: ActionKind
  icon: LucideIcon
  label: MessageKey
  keybind: KeybindId | null
}

const PRIMARY: ActionDef[] = [
  { kind: 'assist', icon: Sparkles, label: 'actions.assist', keybind: 'askAssist' },
  { kind: 'say', icon: WandSparkles, label: 'actions.say', keybind: 'actionSay' },
  {
    kind: 'followups',
    icon: MessageCircle,
    label: 'actions.followups',
    keybind: 'actionFollowups',
  },
  { kind: 'recap', icon: RotateCcw, label: 'actions.recap', keybind: 'actionRecap' },
]

const OVERFLOW: ActionDef[] = [
  { kind: 'factcheck', icon: ShieldCheck, label: 'actions.factcheck', keybind: null },
  { kind: 'who', icon: Users, label: 'actions.who', keybind: null },
]

// The focus ring is drawn inside the button: the toolbar clips overflow (it must never wrap
// or widen the panel), which would cut off an outside ring.
const actionButton =
  'no-drag inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-[12.5px] font-medium whitespace-nowrap text-muted transition-colors duration-150 hover:bg-panel-3 hover:text-fg focus-visible:outline-offset-[-2px]'

const MoreButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(
  function MoreButton(props, ref) {
    return (
      <button
        ref={ref}
        type="button"
        aria-label={t('actions.more')}
        title={t('actions.more')}
        className={cn(actionButton, 'w-7 justify-center px-0 data-[state=open]:bg-panel-3')}
        {...props}
      >
        <Ellipsis size={15} />
      </button>
    )
  },
)

function Dot() {
  return (
    <span aria-hidden className="shrink-0 px-0.5 text-[11px] text-subtle select-none">
      ·
    </span>
  )
}

/** ✨ Assist · 🪄 What should I say? · 💬 Follow-up questions · ↻ Recap · … */
export function ActionRow() {
  const keybinds = useSettings((s) => s.settings.keybinds)
  return (
    <div
      role="toolbar"
      aria-label={t('overlay.panel.actions')}
      className="mb-2 flex items-center overflow-hidden px-0.5"
    >
      {PRIMARY.map((a, i) => {
        const keys = a.keybind ? keybindDisplay(a.keybind, keybinds[a.keybind]) : []
        const Icon = a.icon
        return (
          <Fragment key={a.kind}>
            {i > 0 ? <Dot /> : null}
            <Tooltip
              content={
                <span className="flex items-center gap-2">
                  {t(a.label)}
                  <Keys keys={keys} />
                </span>
              }
            >
              <button
                type="button"
                data-action={a.kind}
                onClick={() => void runAction(a.kind)}
                className={cn(actionButton, a.kind === 'assist' && 'text-fg')}
              >
                <Icon
                  size={14}
                  className={cn('shrink-0', a.kind === 'assist' && 'text-accent-text')}
                />
                {t(a.label)}
              </button>
            </Tooltip>
          </Fragment>
        )
      })}
      <Dot />
      <Menu trigger={<MoreButton />} side="top" align="end">
        {OVERFLOW.map((a) => {
          const Icon = a.icon
          return (
            <MenuItem
              key={a.kind}
              icon={<Icon size={15} />}
              onSelect={() => void runAction(a.kind)}
            >
              {t(a.label)}
            </MenuItem>
          )
        })}
      </Menu>
    </div>
  )
}
