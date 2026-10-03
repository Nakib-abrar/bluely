import { describe, expect, it, vi } from 'vitest'

interface MenuItem {
  label?: string
  type?: string
  enabled?: boolean
  click?: () => void
}

const fakes = vi.hoisted(() => ({
  tooltip: '',
  menu: [] as MenuItem[],
}))

vi.mock('electron', () => ({
  Tray: class {
    on() {}
    setToolTip(text: string) {
      fakes.tooltip = text
    }
    setContextMenu(menu: MenuItem[]) {
      fakes.menu = menu
    }
    destroy() {}
  },
  Menu: { buildFromTemplate: (items: MenuItem[]) => items },
  nativeImage: { createFromPath: () => ({}) },
}))

vi.mock('@main/resources', () => ({ resourcePath: (name: string) => name }))

import { AppTray, type TrayActions } from '@main/tray'

function tray(state: { live: boolean; failed: boolean; overlay: boolean }) {
  const actions: TrayActions = {
    openMain: vi.fn(),
    toggleSession: vi.fn(),
    toggleOverlay: vi.fn(),
    openSettings: vi.fn(),
    quit: vi.fn(),
    isLive: () => state.live,
    captureFailed: () => state.failed,
    isOverlayVisible: () => state.overlay,
  }
  return { tray: new AppTray(actions), actions }
}

const labels = () => fakes.menu.filter((i) => i.type !== 'separator').map((i) => i.label)

describe('AppTray: a call that is no longer captured (live F6/OV-04)', () => {
  it('says "listening" only while capture works', () => {
    const state = { live: true, failed: false, overlay: true }
    const t = tray(state)
    expect(fakes.tooltip).toBe('Bluely: listening')
    expect(labels()[0]).toBe('Open Bluely')

    // The overlay renderer keeps crashing; it is gone, so the tray must not claim to listen.
    state.failed = true
    state.overlay = false
    t.tray.refresh()
    expect(fakes.tooltip).toBe('Bluely: not capturing audio')
    expect(fakes.menu[0]).toMatchObject({
      label: 'Not capturing audio: show the overlay to retry',
      enabled: false,
    })
    // "Show overlay" builds a new overlay, which restarts capture.
    const show = fakes.menu.find((i) => i.label === 'Show overlay')
    show?.click?.()
    expect(t.actions.toggleOverlay).toHaveBeenCalled()
    expect(labels()).toContain('Stop session')

    state.failed = false
    state.overlay = true
    t.tray.refresh()
    expect(fakes.tooltip).toBe('Bluely: listening')
    expect(labels()[0]).toBe('Open Bluely')
  })

  it('is unchanged outside a call', () => {
    tray({ live: false, failed: true, overlay: false })
    expect(fakes.tooltip).toBe('Bluely')
    expect(labels()).toEqual([
      'Open Bluely',
      'Start Bluely',
      'Show overlay',
      'Settings',
      'Quit Bluely',
    ])
  })
})
