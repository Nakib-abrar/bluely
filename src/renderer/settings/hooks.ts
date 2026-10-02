import { useEffect, useRef, useState } from 'react'
import type { AppInfo } from '@shared/types'
import { invoke } from '../lib/ipc'

let appInfoCache: AppInfo | null = null
let appInfoRequest: Promise<AppInfo> | null = null

/** App version, data folder etc. Fetched once per window and cached. */
export function useAppInfo(): AppInfo | null {
  const [info, setInfo] = useState<AppInfo | null>(appInfoCache)
  useEffect(() => {
    if (appInfoCache) return
    let alive = true
    appInfoRequest ??= invoke('app:getInfo')
    appInfoRequest
      .then((i) => {
        appInfoCache = i
        if (alive) setInfo(i)
      })
      .catch(() => {
        appInfoRequest = null
      })
    return () => {
      alive = false
    }
  }, [])
  return info
}

/**
 * Debounced autosave: `schedule(patch)` merges patches and flushes them after `delayMs` of quiet.
 * Pending changes are flushed on unmount so closing Settings never loses typing.
 */
export function useDebouncedSave<P extends object>(
  save: (patch: P) => Promise<unknown>,
  delayMs = 500,
): {
  schedule: (patch: P) => void
  flush: () => void
  state: 'idle' | 'saving' | 'saved' | 'error'
  error: string | null
} {
  const pending = useRef<P | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveRef = useRef(save)
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    saveRef.current = save
  })

  const flushRef = useRef<() => void>(() => undefined)
  useEffect(() => {
    flushRef.current = () => {
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
      const patch = pending.current
      pending.current = null
      if (!patch) return
      setState('saving')
      saveRef
        .current(patch)
        .then(() => {
          setError(null)
          setState('saved')
        })
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : String(err))
          setState('error')
        })
    }
  })

  useEffect(() => () => flushRef.current(), [])

  return {
    schedule: (patch: P) => {
      pending.current = { ...(pending.current ?? {}), ...patch } as P
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => flushRef.current(), delayMs)
    },
    flush: () => flushRef.current(),
    state,
    error,
  }
}
