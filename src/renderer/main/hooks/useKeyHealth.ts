import { create } from 'zustand'
import { t } from '@shared/i18n'
import type { KeyStatus } from '@shared/types'
import { invoke, IpcError } from '../../lib/ipc'

export type KeyCheck = 'idle' | 'checking' | 'ok' | 'error'

interface KeyHealthState {
  status: KeyStatus | null
  check: KeyCheck
  /** Friendly message when the last key test failed. */
  error: string | null
  /** Masked key the cached test result belongs to; a new key re-runs the test. */
  testedMasked: string | null
  /**
   * Re-reads the key status and tests the key when it has not been tested yet (or changed).
   * `retest` forces a new 'key:test' (refresh button).
   */
  refresh(opts?: { retest?: boolean }): Promise<void>
}

let run = 0

function friendly(err: unknown): string {
  if (err instanceof IpcError && err.ai) return err.ai.message
  return t('home.header.checkFailed')
}

/**
 * OpenRouter key presence + connectivity, cached for the window's lifetime so the
 * header does not re-test the key on every navigation.
 */
export const useKeyHealth = create<KeyHealthState>((set, get) => ({
  status: null,
  check: 'idle',
  error: null,
  testedMasked: null,
  async refresh(opts) {
    const mine = ++run
    let status: KeyStatus
    try {
      status = await invoke('key:getStatus')
    } catch (err) {
      if (mine === run) set({ check: 'error', error: friendly(err) })
      return
    }
    if (mine !== run) return
    if (!status.hasKey) {
      set({ status, check: 'idle', error: null, testedMasked: null })
      return
    }
    const prev = get()
    const needsTest =
      opts?.retest === true || prev.check === 'idle' || prev.testedMasked !== status.masked
    if (!needsTest) {
      set({ status })
      return
    }
    set({ status, check: 'checking', error: null })
    try {
      const result = await invoke('key:test')
      if (mine !== run) return
      set(
        result.ok
          ? { check: 'ok', error: null, testedMasked: status.masked }
          : {
              check: 'error',
              error: result.error?.message ?? t('home.header.checkFailed'),
              testedMasked: status.masked,
            },
      )
    } catch (err) {
      if (mine === run) set({ check: 'error', error: friendly(err), testedMasked: status.masked })
    }
  },
}))
