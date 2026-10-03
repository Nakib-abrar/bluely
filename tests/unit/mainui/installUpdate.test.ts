import { describe, expect, it } from 'vitest'
import type { LiveStatus } from '@shared/types'
import { installUpdate, updateBlocker, type InstallDeps } from '@renderer/main/lib/installUpdate'

/**
 * A fake session + updater, recording the calls in order. Like main, `install` refuses while a
 * call runs or the notes of one that just ended are being written.
 */
function fakeMain(initial: LiveStatus) {
  let status = initial
  const calls: string[] = []
  const listeners = new Set<(s: LiveStatus) => void>()
  const setStatus = (next: LiveStatus) => {
    status = next
    for (const l of [...listeners]) l(next)
  }
  const deps: InstallDeps = {
    getStatus: async () => status,
    stop: async () => {
      calls.push('stop')
      // SessionManager.stop(): the call ends and its notes start ('processing').
      setStatus('processing')
    },
    onStatus: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    install: async () => {
      calls.push(`install:${status}`)
      if (status !== 'idle') throw new Error(`refused while ${status}`)
    },
  }
  return { deps, calls, setStatus, listeners }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('updateBlocker', () => {
  it('asks before stopping a call, or while its notes are written', () => {
    expect(updateBlocker('starting')).toBe('call')
    expect(updateBlocker('live')).toBe('call')
    expect(updateBlocker('stopping')).toBe('call')
    expect(updateBlocker('processing')).toBe('notes')
    expect(updateBlocker('idle')).toBeNull()
  })
})

describe('installUpdate', () => {
  it('installs right away when nothing runs', async () => {
    const main = fakeMain('idle')
    await installUpdate(main.deps, new AbortController().signal)
    expect(main.calls).toEqual(['install:idle'])
  })

  for (const status of ['starting', 'live', 'stopping'] as const) {
    it(`stops a call that is ${status}, waits for its notes, then installs`, async () => {
      const main = fakeMain(status)
      const done = installUpdate(main.deps, new AbortController().signal)
      await tick()
      // Stopped, and waiting while the notes are written: no install yet.
      expect(main.calls).toEqual(['stop'])
      main.setStatus('idle')
      await done
      expect(main.calls).toEqual(['stop', 'install:idle'])
      expect(main.listeners.size).toBe(0)
    })
  }

  it('waits for the notes of the call that just ended', async () => {
    const main = fakeMain('processing')
    const done = installUpdate(main.deps, new AbortController().signal)
    await tick()
    expect(main.calls).toEqual([])
    main.setStatus('idle')
    await done
    expect(main.calls).toEqual(['install:idle'])
  })

  it('does not install when the user cancels while waiting', async () => {
    const main = fakeMain('live')
    const ctrl = new AbortController()
    const done = installUpdate(main.deps, ctrl.signal)
    await tick()
    ctrl.abort()
    await done
    main.setStatus('idle')
    await tick()
    expect(main.calls).toEqual(['stop'])
    expect(main.listeners.size).toBe(0)
  })

  it('leaves it to main when a new call started while waiting (main refuses then)', async () => {
    const main = fakeMain('processing')
    const done = installUpdate(main.deps, new AbortController().signal)
    await tick()
    main.setStatus('starting')
    await expect(done).rejects.toThrow('refused while starting')
    expect(main.calls).toEqual(['install:starting'])
  })
})
