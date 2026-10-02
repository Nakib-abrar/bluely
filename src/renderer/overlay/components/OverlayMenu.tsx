import {
  AppWindow,
  ArrowUpDown,
  CircleStop,
  Ellipsis,
  Eraser,
  EyeOff,
  Layers,
  MessageCircle,
  Move,
  PanelTop,
  Settings,
  Sparkles,
} from 'lucide-react'
import { DropdownMenu as M } from 'radix-ui'
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { t, type MessageKey } from '@shared/i18n'
import { keybindDisplay, type KeybindId } from '@shared/keybinds'
import { cn, MenuItem, MenuLabel, MenuSeparator, MenuSub, MenuToggle } from '../../components/ui'
import { invoke } from '../../lib/ipc'
import { useSettings } from '../../stores/settings'
import { assistShortcut, clearChat, openSettings, reportError, stopSession } from '../actions'
import { useActiveMode } from '../hooks/useActiveMode'
import { useLive } from '../stores/liveStore'
import { ModeRadioItems } from './ModeChip'

interface KeybindRow {
  id: KeybindId
  icon: ReactNode
  label: MessageKey
  run?: () => void
}

const ROWS: KeybindRow[] = [
  {
    id: 'toggleOverlay',
    icon: <PanelTop size={15} />,
    label: 'keybinds.toggleOverlay',
    run: () => invoke('overlay:setVisible', { visible: false }).catch(reportError),
  },
  {
    id: 'askAssist',
    icon: <MessageCircle size={15} />,
    label: 'keybinds.askAssist',
    run: () => assistShortcut('local'),
  },
  {
    id: 'clearChat',
    icon: <Eraser size={15} />,
    label: 'keybinds.clearChat',
    run: () => void clearChat(),
  },
  {
    id: 'stopSession',
    icon: <CircleStop size={15} />,
    label: 'keybinds.stopSession',
    run: stopSession,
  },
  { id: 'moveOverlay', icon: <Move size={15} />, label: 'keybinds.moveOverlay' },
  { id: 'scrollChat', icon: <ArrowUpDown size={15} />, label: 'keybinds.scrollChat' },
]

/** How far left of the "…" button the menu starts (the tier chip sits before it). */
const MENU_SHIFT_LEFT = 84

const Trigger = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(
  function Trigger(props, ref) {
    return (
      <button
        ref={ref}
        type="button"
        aria-label={t('overlay.menu.open')}
        title={t('overlay.menu.open')}
        className="no-drag inline-flex h-6 w-7 items-center justify-center rounded-md text-muted transition-colors duration-150 hover:bg-panel-3 hover:text-fg data-[state=open]:bg-panel-3 data-[state=open]:text-fg"
        {...props}
      >
        <Ellipsis size={16} />
      </button>
    )
  },
)

/**
 * The "…" menu next to the input: keybind reference (rows also run their action),
 * widget options, the mode switcher, and shortcuts to the main window and Settings.
 */
export function OverlayMenu() {
  const keybinds = useSettings((s) => s.settings.keybinds)
  const hideHidesWidget = useSettings((s) => s.settings.general.hideHidesWidget)
  const status = useLive((s) => s.state.status)
  const autoSuggest = useLive((s) => s.state.autoSuggest)
  const { modes, activeId } = useActiveMode()
  const live = status === 'live' || status === 'starting'

  return (
    <M.Root modal={false}>
      <M.Trigger asChild>
        <Trigger />
      </M.Trigger>
      <M.Portal>
        <M.Content
          side="top"
          align="start"
          // The window is only ~560 px wide: start the menu at the panel's left edge so the
          // Modes submenu still fits to its right.
          alignOffset={-MENU_SHIFT_LEFT}
          sideOffset={8}
          collisionPadding={8}
          className={cn(
            'z-50 w-[272px] rounded-xl border border-ov-line bg-panel-2 p-1.5 text-fg shadow-panel animate-fade-in',
          )}
        >
          <MenuLabel>{t('overlay.menu.keybinds')}</MenuLabel>
          {ROWS.map((row) => (
            <MenuItem
              key={row.id}
              icon={row.icon}
              keys={keybindDisplay(row.id, keybinds[row.id])}
              onSelect={row.run}
              disabled={row.id === 'stopSession' && !live}
            >
              {t(row.label)}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuToggle
            icon={<EyeOff size={15} />}
            checked={hideHidesWidget}
            onCheckedChange={(v) => {
              useSettings
                .getState()
                .update({ general: { hideHidesWidget: v } })
                .catch(reportError)
            }}
          >
            {t('overlay.menu.hideHidesWidget')}
          </MenuToggle>
          {live ? (
            <MenuToggle
              icon={<Sparkles size={15} />}
              checked={autoSuggest}
              onCheckedChange={(enabled) => {
                invoke('session:setAutoSuggest', { enabled }).catch(reportError)
              }}
            >
              {t('overlay.menu.autoSuggest')}
            </MenuToggle>
          ) : null}
          <MenuSub icon={<Layers size={15} />} label={t('overlay.menu.modes')}>
            <ModeRadioItems modes={modes} activeId={activeId} />
          </MenuSub>
          <MenuSeparator />
          <MenuItem
            icon={<AppWindow size={15} />}
            onSelect={() => {
              invoke('app:openMainWindow', {}).catch(reportError)
            }}
          >
            {t('overlay.menu.openMain')}
          </MenuItem>
          <MenuItem icon={<Settings size={15} />} onSelect={() => openSettings()}>
            {t('overlay.menu.settings')}
          </MenuItem>
        </M.Content>
      </M.Portal>
    </M.Root>
  )
}
