/**
 * User-facing strings in the shared UI kit and the main window go through t(). t() is replaced
 * with a marker-returning fake, so any hardcoded English shows up as a mismatch.
 */
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type * as RadixUi from 'radix-ui'
import { describe, expect, it, vi } from 'vitest'
import type { SessionDetail } from '@shared/types'

vi.mock('@shared/i18n', () => ({
  t: (key: string, vars?: Record<string, string | number>) =>
    vars ? `[${key} ${Object.values(vars).join(' / ')}]` : `[${key}]`,
}))

// Radix renders dialogs into a portal only after mounting, which never happens in a server
// render; pass the parts straight through instead.
vi.mock('radix-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof RadixUi>()
  const pass =
    (tag: string) =>
    ({ children, asChild: _a, forceMount: _f, ...props }: Record<string, unknown>) =>
      createElement(tag, props, children as ReactNode)
  return {
    ...actual,
    Dialog: {
      Root: ({ children }: { children: ReactNode }) => children,
      Portal: ({ children }: { children: ReactNode }) => children,
      Overlay: pass('div'),
      Content: pass('div'),
      Title: pass('h2'),
      Description: pass('p'),
      Close: pass('button'),
    },
  }
})

const { Banner } = await import('@renderer/components/ui/Banner')
const { Dialog } = await import('@renderer/components/ui/Dialog')
const { formatPerMillion } = await import('@renderer/lib/format')
const { SessionBanners } = await import('@renderer/main/components/SessionBanners')

describe('UI strings go through t()', () => {
  it('Banner dismiss button', () => {
    const html = renderToStaticMarkup(
      createElement(Banner, { tone: 'info', title: 'T', onDismiss: () => undefined }),
    )
    expect(html).toContain('aria-label="[common.dismiss]"')
    expect(html).not.toContain('"Dismiss"')
  })

  it('Dialog close button', () => {
    const html = renderToStaticMarkup(
      createElement(Dialog, { open: true, onOpenChange: () => undefined, title: 'T' }),
    )
    expect(html).toContain('aria-label="[common.close]"')
    expect(html).not.toContain('"Close"')
  })

  it('free model price', () => {
    expect(formatPerMillion(0)).toBe('[common.free]')
    expect(formatPerMillion(0.0000004)).toBe('$0.400/M')
  })

  it('post-call part failures are labelled per part, not with English part ids', () => {
    const detail = {
      id: 's1',
      title: 'Call',
      status: 'done',
      postCallError: 'notes: Timed out. · email: Rate limited.',
    } as SessionDetail
    const html = renderToStaticMarkup(
      createElement(SessionBanners, { detail, onRegenerate: () => undefined, regenerating: false }),
    )
    expect(html).toContain('[session.banner.partError [session.banner.part.notes] / Timed out.]')
    expect(html).toContain('[session.banner.partError [session.banner.part.email] / Rate limited.]')
    expect(html).not.toContain('notes: Timed out.')
  })

  it('a whole-run failure message is shown as is', () => {
    const detail = {
      id: 's1',
      title: 'Call',
      status: 'failed',
      postCallError: 'The notes model timed out.',
    } as SessionDetail
    const html = renderToStaticMarkup(
      createElement(SessionBanners, { detail, onRegenerate: () => undefined, regenerating: false }),
    )
    expect(html).toContain('The notes model timed out.')
  })
})
