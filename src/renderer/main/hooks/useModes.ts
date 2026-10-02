import { useEffect, useState } from 'react'
import { BUILTIN_MODES } from '@shared/builtinModes'
import type { Mode } from '@shared/types'
import { invoke } from '../../lib/ipc'
import { useIpcEvent } from '../../hooks/useIpcEvent'
import { useRefresh } from '../stores/refresh'

/**
 * Modes for the header pill. Falls back to the built-in starters while the modes
 * backend is unavailable so the pill never renders empty.
 */
export function useModes(): Mode[] {
  const [modes, setModes] = useState<Mode[]>(BUILTIN_MODES)
  const nonce = useRefresh((s) => s.nonce)
  useEffect(() => {
    let alive = true
    invoke('modes:list')
      .then((list) => alive && list.length > 0 && setModes(list))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [nonce])
  useIpcEvent('modes:changed', (list) => {
    if (list.length > 0) setModes(list)
  })
  return modes
}
