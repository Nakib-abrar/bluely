import { useCallback, useEffect, useState } from 'react'
import type { Notice } from '@shared/types'
import { invoke } from '../../lib/ipc'
import { useIpcEvent } from '../../hooks/useIpcEvent'
import { useRefresh } from '../stores/refresh'

/** App notices (missing key, update available, recovered session, …) shown as banners. */
export function useNotices(): { notices: Notice[]; dismiss(id: string): void } {
  const [notices, setNotices] = useState<Notice[]>([])
  const nonce = useRefresh((s) => s.nonce)
  useEffect(() => {
    let alive = true
    invoke('app:getNotices')
      .then((list) => alive && setNotices(list))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [nonce])
  useIpcEvent('app:notices', setNotices)
  const dismiss = useCallback((id: string) => {
    // Optimistic: main persists the dismissal and pushes the new list.
    setNotices((list) => list.filter((n) => n.id !== id))
    void invoke('app:dismissNotice', { id }).catch(() => undefined)
  }, [])
  return { notices, dismiss }
}
