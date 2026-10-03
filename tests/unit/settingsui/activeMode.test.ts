import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type Settings } from '@shared/settings'

/** Pending modes:setActive calls; the test settles them like main would. */
const pending: { id: string; resolve: () => void; reject: (err: Error) => void }[] = []

vi.mock('@renderer/lib/ipc', () => ({
  invoke: vi.fn((channel: string, payload?: { id: string }) => {
    if (channel !== 'modes:setActive' || !payload) return Promise.resolve(undefined)
    return new Promise<void>((resolve, reject) => pending.push({ id: payload.id, resolve, reject }))
  }),
  on: vi.fn(() => () => undefined),
  IpcError: class extends Error {},
}))

const { useSettings } = await import('@renderer/stores/settings')
const { resolveActiveModeId, useModes } = await import('@renderer/settings/stores')

/** What Settings › General, the Modes page and onboarding show as the active Mode. */
const shown = () =>
  resolveActiveModeId(
    useSettings.getState().settings.activeModeId,
    useModes.getState().activeChoice,
  )

/** main's settings:changed echo (or a change made by another window/control). */
function settingsChanged(activeModeId: string) {
  const settings: Settings = { ...useSettings.getState().settings, activeModeId }
  useSettings.setState({ settings })
}

describe('active Mode shown by Settings', () => {
  beforeEach(() => {
    pending.length = 0
    useModes.setState({ activeChoice: null })
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, activeModeId: 'builtin-general' } })
  })

  it('shows the choice right away, then follows settings', async () => {
    const done = useModes.getState().setActive('builtin-sales')
    expect(shown()).toBe('builtin-sales') // optimistic, before main answers
    settingsChanged('builtin-sales') // main's echo
    pending.shift()?.resolve()
    await done
    expect(useModes.getState().activeChoice).toBeNull()
    expect(shown()).toBe('builtin-sales')
  })

  it('does not resurrect an old choice when the Mode is switched back elsewhere', async () => {
    // Onboarding: pick Sales (made against General).
    const done = useModes.getState().setActive('builtin-sales')
    settingsChanged('builtin-sales')
    pending.shift()?.resolve()
    await done
    // Later the header Mode pill (or the overlay) switches back to General directly.
    settingsChanged('builtin-general')
    expect(shown()).toBe('builtin-general')
  })

  it('drops the choice when settings move on before main answers', async () => {
    const done = useModes.getState().setActive('builtin-sales')
    settingsChanged('builtin-sales')
    settingsChanged('builtin-general') // e.g. the header pill, right after
    pending.shift()?.resolve()
    await done
    expect(shown()).toBe('builtin-general')
  })

  it('reverts to the real setting when main refuses', async () => {
    const done = useModes.getState().setActive('missing-mode')
    expect(shown()).toBe('missing-mode')
    pending.shift()?.reject(new Error('No such Mode'))
    await expect(done).rejects.toThrow('No such Mode')
    expect(useModes.getState().activeChoice).toBeNull()
    expect(shown()).toBe('builtin-general')
  })

  it('keeps the newest choice when an older request fails', async () => {
    const first = useModes.getState().setActive('builtin-sales')
    const second = useModes.getState().setActive('builtin-standup')
    pending.shift()?.reject(new Error('busy'))
    await expect(first).rejects.toThrow('busy')
    expect(shown()).toBe('builtin-standup')
    settingsChanged('builtin-standup')
    pending.shift()?.resolve()
    await second
    expect(shown()).toBe('builtin-standup')
  })
})
