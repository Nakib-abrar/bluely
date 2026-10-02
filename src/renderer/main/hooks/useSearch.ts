import { useEffect, useRef, useState } from 'react'
import type { SearchResult } from '@shared/types'
import { errorMessage, invoke } from '../../lib/ipc'

export const SEARCH_DEBOUNCE_MS = 150

export interface SearchView {
  /** Latest result. While a newer query loads, the previous result stays (no flashing). */
  result: SearchResult | null
  loading: boolean
  error: string | null
}

interface Settled {
  q: string
  result: SearchResult | null
  error: string | null
}

/** Debounced full-text search ('search:query'); stale responses are ignored. */
export function useSearch(query: string): SearchView {
  const [settled, setSettled] = useState<Settled | null>(null)
  const token = useRef(0)
  const q = query.trim()

  useEffect(() => {
    const mine = ++token.current
    if (!q) return
    const timer = setTimeout(() => {
      invoke('search:query', { query: q, limit: 60 })
        .then((result) => {
          if (mine === token.current) setSettled({ q, result, error: null })
        })
        .catch((err: unknown) => {
          if (mine === token.current) setSettled({ q, result: null, error: errorMessage(err) })
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [q])

  if (!q) return { result: null, loading: false, error: null }
  const current = settled?.q === q
  return {
    result: settled?.result ?? null,
    loading: !current,
    error: current ? (settled?.error ?? null) : null,
  }
}
