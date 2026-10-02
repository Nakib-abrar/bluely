import { useCallback, useEffect, useRef, useState } from 'react'
import type { SessionDetail } from '@shared/types'
import { errorMessage, invoke } from '../../lib/ipc'
import { useIpcEvent } from '../../hooks/useIpcEvent'

export interface SessionDetailView {
  detail: SessionDetail | null
  status: 'loading' | 'ready' | 'missing' | 'error'
  error: string | null
  reload(): void
  /** Local optimistic edit (title, action item, email). */
  patch(fn: (d: SessionDetail) => SessionDetail): void
}

/**
 * One meeting ('sessions:get'), refreshed when main reports it changed.
 * Callers key the page by session id, so state never leaks between meetings.
 */
export function useSessionDetail(id: string): SessionDetailView {
  const [detail, setDetail] = useState<SessionDetail | null>(null)
  const [status, setStatus] = useState<SessionDetailView['status']>('loading')
  const [error, setError] = useState<string | null>(null)
  const token = useRef(0)

  const reload = useCallback(() => {
    const mine = ++token.current
    invoke('sessions:get', { id })
      .then((d) => {
        if (mine !== token.current) return
        setDetail(d)
        setStatus(d ? 'ready' : 'missing')
        setError(null)
      })
      .catch((err: unknown) => {
        if (mine !== token.current) return
        // Keep showing what we have if a background refresh fails.
        setStatus((s) => (s === 'ready' ? s : 'error'))
        setError(errorMessage(err))
      })
  }, [id])

  useEffect(() => {
    reload()
  }, [reload])

  useIpcEvent('sessions:changed', (p) => {
    if (p.id === null || p.id === id) reload()
  })

  const patch = useCallback((fn: (d: SessionDetail) => SessionDetail) => {
    setDetail((d) => (d ? fn(d) : d))
  }, [])

  return { detail, status, error, reload, patch }
}
