import { describe, expect, it } from 'vitest'
import type { KeybindStatus, Notice } from '@shared/types'
import { NoticeCenter } from '@main/live/notices'
import { createHarness } from './harness'

function status(over: Partial<KeybindStatus> & Pick<KeybindStatus, 'id'>): KeybindStatus {
  return { accelerator: null, registered: true, error: null, reason: null, ...over }
}

describe('NoticeCenter: shortcuts taken by another app (platform F6)', () => {
  it('shows a dismissible banner that opens Settings › Keybinds', () => {
    const h = createHarness()
    const notices = new NoticeCenter(h.ctx, h.history)
    h.events.broadcast('keybinds:status', [
      status({
        id: 'toggleOverlay',
        accelerator: 'CommandOrControl+\\',
        registered: false,
        error: 'Taken by another app',
        reason: 'taken',
      }),
      status({ id: 'askAssist', accelerator: 'CommandOrControl+Enter' }),
      // Inactive by design (overlay hidden): not a problem.
      status({ id: 'moveOverlay', accelerator: 'CommandOrControl', registered: false, reason: 'inactive' }),
    ])
    const banner = notices.list().find((n) => n.id.startsWith('keybinds-taken-')) as Notice
    expect(banner).toMatchObject({
      kind: 'warning',
      title: 'Some shortcuts are taken by another app',
      dismissible: true,
      action: { action: { type: 'openSettings', page: 'keybinds' } },
    })
    expect(banner.body).toContain('Ctrl+\\')
    // Published to the main window right away.
    const published = h.eventsOf('app:notices').at(-1) as Notice[]
    expect(published.map((n) => n.id)).toContain(banner.id)

    // Once the shortcut registers (other app closed or rebound), the banner goes away.
    h.events.broadcast('keybinds:status', [
      status({ id: 'toggleOverlay', accelerator: 'CommandOrControl+\\' }),
    ])
    expect(notices.list().some((n) => n.id.startsWith('keybinds-taken-'))).toBe(false)
  })

  it('recognises statuses without a reason by their error text, and ignores local binds', () => {
    const h = createHarness()
    const notices = new NoticeCenter(h.ctx, h.history)
    h.events.broadcast('keybinds:status', [
      status({
        id: 'actionSay',
        accelerator: 'CommandOrControl+Shift+1',
        registered: false,
        error: 'Taken by another app',
      }),
      status({ id: 'clearChat', accelerator: 'CommandOrControl+R', registered: false, error: 'x' }),
    ])
    const ids = notices.list().map((n) => n.id)
    expect(ids).toContain('keybinds-taken-CommandOrControl+Shift+1')
  })

  it('stays dismissed for the same set of shortcuts', () => {
    const h = createHarness()
    const notices = new NoticeCenter(h.ctx, h.history)
    const taken = status({
      id: 'stopSession',
      accelerator: 'CommandOrControl+Shift+\\',
      registered: false,
      reason: 'taken',
    })
    h.events.broadcast('keybinds:status', [taken])
    const id = notices.list().find((n) => n.id.startsWith('keybinds-taken-'))?.id as string
    notices.dismiss(id)
    h.events.broadcast('keybinds:status', [taken])
    expect(notices.list().some((n) => n.id === id)).toBe(false)
  })
})
