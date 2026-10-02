import { useCallback, useEffect, useRef, useState } from 'react'
import type { SessionSummary } from '@shared/types'
import { errorMessage, invoke } from '../../lib/ipc'
import { useIpcEvent } from '../../hooks/useIpcEvent'
import { mergeSessions } from '../lib/group'
import { useRefresh } from '../stores/refresh'

export const SESSIONS_PAGE = 50
const MAX_RELOAD = 500

export interface SessionsView {
  sessions: SessionSummary[]
  status: 'loading' | 'ready' | 'error'
  error: string | null
  hasMore: boolean
  loadingMore: boolean
  loadMore(): void
  reload(): void
  /** Optimistically removes a row (after a successful delete). */
  remove(id: string): void
}

/** Paged meeting history ('sessions:list'), refreshed on 'sessions:changed'. */
export function useSessions(): SessionsView {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [status, setStatus] = useState<SessionsView['status']>('loading')
  const [error, setError] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const token = useRef(0)
  const loaded = useRef(0)
  const nonce = useRefresh((s) => s.nonce)

  const reload = useCallback(() => {
    const mine = ++token.current
    // Keep every row the user already paged in.
    const limit = Math.min(MAX_RELOAD, Math.max(SESSIONS_PAGE, loaded.current))
    invoke('sessions:list', { limit })
      .then((page) => {
        if (mine !== token.current) return
        loaded.current = page.length
        setSessions(page)
        setHasMore(page.length >= limit)
        setStatus('ready')
        setError(null)
      })
      .catch((err: unknown) => {
        if (mine !== token.current) return
        setStatus((s) => (s === 'ready' ? s : 'error'))
        setError(errorMessage(err))
      })
  }, [])

  useEffect(() => {
    reload()
  }, [reload, nonce])

  useIpcEvent('sessions:changed', () => reload())

  const loadMore = useCallback(() => {
    const last = sessions[sessions.length - 1]
    if (!last || loadingMore) return
    setLoadingMore(true)
    const mine = token.current
    invoke('sessions:list', { limit: SESSIONS_PAGE, before: last.startedAt })
      .then((page) => {
        if (mine !== token.current) return
        setSessions((cur) => {
          const next = mergeSessions(cur, page)
          loaded.current = next.length
          return next
        })
        setHasMore(page.length >= SESSIONS_PAGE)
      })
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setLoadingMore(false))
  }, [sessions, loadingMore])

  const remove = useCallback((id: string) => {
    setSessions((cur) => cur.filter((s) => s.id !== id))
  }, [])

  return { sessions, status, error, hasMore, loadingMore, loadMore, reload, remove }
}
