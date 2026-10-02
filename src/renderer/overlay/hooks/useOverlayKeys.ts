import { useEffect } from 'react'
import { keyEventToAccelerator, normalizeAccelerator, type KeybindMap } from '@shared/keybinds'
import { invoke, on } from '../../lib/ipc'
import { useSettings } from '../../stores/settings'
import { assistShortcut, clearChat, runAction, selectTab, setExpanded } from '../actions'
import { useUi } from '../stores/uiStore'
import { scrollList } from './useStickToBottom'

export type LocalKeyAction =
  | { type: 'clearChat' }
  | { type: 'devPanel' }
  | { type: 'assist' }
  | { type: 'scroll'; direction: 'up' | 'down' }

type KeyLike = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>

/** Maps a keydown to a local overlay keybind (pure; exported for tests). */
export function matchLocalKey(e: KeyLike, keybinds: KeybindMap): LocalKeyAction | null {
  const single = keyEventToAccelerator(e, 'single')
  const is = (acc: string | null) => !!acc && !!single && normalizeAccelerator(acc) === single
  if (is(keybinds.clearChat)) return { type: 'clearChat' }
  if (is(keybinds.devPanel)) return { type: 'devPanel' }
  if (is(keybinds.askAssist)) return { type: 'assist' }
  if (keybinds.scrollChat && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    const prefix = keyEventToAccelerator(e, 'arrows2')
    if (prefix && prefix === normalizeAccelerator(keybinds.scrollChat)) {
      return { type: 'scroll', direction: e.key === 'ArrowUp' ? 'up' : 'down' }
    }
  }
  return null
}

function openPanel(): void {
  if (!useUi.getState().expanded) void setExpanded(true)
}

/**
 * Local keybinds while the overlay is focused (clear chat, scroll, dev panel, Assist, Esc)
 * and the global shortcut commands main forwards as overlay:command.
 */
export function useOverlayKeys(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing || e.defaultPrevented) return
      const action = matchLocalKey(e, useSettings.getState().settings.keybinds)
      if (action) {
        e.preventDefault()
        const ui = useUi.getState()
        if (action.type === 'clearChat') void clearChat()
        else if (action.type === 'devPanel') ui.toggleDev()
        else if (action.type === 'assist') assistShortcut('local')
        else scrollList(ui.tab, action.direction)
        return
      }
      if (e.key === 'Escape') {
        const active = document.activeElement
        // Open menus handle Esc themselves (and restore focus to their trigger).
        if (active instanceof HTMLElement && !active.closest('[role="menu"]')) active.blur()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(
    () =>
      on('overlay:command', (cmd) => {
        const ui = useUi.getState()
        switch (cmd.type) {
          case 'assist':
            assistShortcut('global')
            break
          case 'focusInput':
            openPanel()
            // The user wants to type: the window itself needs OS focus, not just the element.
            invoke('overlay:focus').catch(() => undefined)
            ui.requestFocus()
            break
          case 'action':
            void runAction(cmd.action)
            break
          case 'clearChat':
            void clearChat()
            break
          case 'scroll':
            scrollList(ui.tab, cmd.direction)
            break
          case 'toggleDevPanel':
            openPanel()
            ui.toggleDev()
            break
          case 'setTab':
            openPanel()
            selectTab(cmd.tab)
            break
        }
      }),
    [],
  )
}
