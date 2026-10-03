import { useCallback, useEffect, useRef, useState } from 'react'
import type { Notice } from '@shared/types'
import { invoke } from '../../lib/ipc'
import { useIpcEvent } from '../../hooks/useIpcEvent'
import { useRefresh } from '../stores/refresh'

/** App notices (missing key, update available, recovered session, …) shown as banners. */
export function useNotices(): { notices: Notice[]; dismiss(id: string): void } {
  const [notices, setNotices] = useState<Notice[]>([])
  // Notices dismissed in this window. Main publishes its list whenever something changes (startup
  // model validation, an update check), so a list computed just before main handled a dismissal
  // can arrive after the click; main never shows a dismissed notice again, and neither do we.
  const dismissed = useRef(new Set<string>())
  const show = useCallback(
    (list: Notice[]) => setNotices(list.filter((n) => !dismissed.current.has(n.id))),
    [],
  )
  const nonce = useRefresh((s) => s.nonce)
  useEffect(() => {
    let alive = true
    invoke('app:getNotices')
      .then((list) => alive && show(list))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [nonce, show])
  useIpcEvent('app:notices', show)
  const dismiss = useCallback((id: string) => {
    // Optimistic: main persists the dismissal and pushes the new list.
    dismissed.current.add(id)
    setNotices((list) => list.filter((n) => n.id !== id))
    void invoke('app:dismissNotice', { id }).catch(() => undefined)
  }, [])
  return { notices, dismiss }
}
