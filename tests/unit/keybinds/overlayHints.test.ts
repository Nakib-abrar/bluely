/**
 * The overlay's keycap hints come from keybindDisplay, so a hand-edited bind that main does not
 * register (Settings: "Invalid shortcut") is never advertised there. Rendered on the server, as
 * the visible hints (Ask placeholder, dev panel header) need no open menu or tooltip.
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_KEYBINDS, type KeybindMap } from '@shared/keybinds'

vi.stubGlobal('window', {
  bluely: {
    invoke: async () => ({ ok: true, data: null }),
    on: () => () => undefined,
    platform: 'win32',
  },
  // Imported via the settings store (theme.ts); never used here.
  matchMedia: () => ({ matches: true, addEventListener: () => undefined }),
})

const { useSettings } = await import('../../../src/renderer/stores/settings')
const { AskInput } = await import('../../../src/renderer/overlay/components/AskInput')
const { DevPanel } = await import('../../../src/renderer/overlay/components/DevPanel')
const { TooltipProvider } = await import('../../../src/renderer/components/ui')

// Server rendering reads zustand's initial state (its server snapshot), so binds go there.
const store = useSettings.getInitialState()
const initial = store.settings

function withKeybinds(patch: Partial<KeybindMap>): void {
  store.settings = { ...initial, keybinds: { ...DEFAULT_KEYBINDS, ...patch } }
}

/** The keycaps (<kbd>) a component renders, in order. */
function keycaps(component: () => unknown): string[] {
  const html = renderToStaticMarkup(
    createElement(TooltipProvider, null, createElement(component as () => null)),
  )
  return [...html.matchAll(/<kbd[^>]*>([^<]*)<\/kbd>/g)].map((m) => m[1] ?? '')
}

afterEach(() => {
  store.settings = initial
})

describe('overlay keycap hints', () => {
  it('show usable binds in canonical order', () => {
    withKeybinds({ askAssist: 'shift+ctrl+enter', devPanel: 'F9' })
    expect(keycaps(AskInput)).toEqual(['Ctrl', 'Shift', '↵'])
    expect(keycaps(DevPanel)).toEqual(['F9'])
  })

  it('do not advertise Shift-only or reserved binds that do nothing', () => {
    withKeybinds({ askAssist: 'Shift+Enter', devPanel: 'Ctrl+C' })
    expect(keycaps(AskInput)).toEqual([])
    expect(keycaps(DevPanel)).toEqual([])
    withKeybinds({ askAssist: 'Alt+Shift+Enter', devPanel: 'Shift+D' })
    expect(keycaps(AskInput)).toEqual(['Alt', 'Shift', '↵'])
    expect(keycaps(DevPanel)).toEqual([])
  })
})
