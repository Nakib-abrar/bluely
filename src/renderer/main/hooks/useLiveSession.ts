import { useEffect, useState } from 'react'
import { create } from 'zustand'
import type { LiveSessionState } from '@shared/types'
import { invoke, on } from '../../lib/ipc'

interface LiveStore {
  state: LiveSessionState | null
  fetch(): Promise<void>
}

const useLiveStore = create<LiveStore>((set) => ({
  state: null,
  async fetch() {
    try {
      set({ state: await invoke('session:getState') })
    } catch {
      /* no session backend yet: keep showing "Start" */
    }
  },
}))

let subscribed = false

/** Subscribes to 'session:state' once and loads the initial state. */
export function initLiveSession(): void {
  if (subscribed) return
  subscribed = true
  on('session:state', (state) => useLiveStore.setState({ state }))
  void useLiveStore.getState().fetch()
}

/** Current live-session state shared by every Start/Stop button. */
export function useLiveSession(): LiveSessionState | null {
  return useLiveStore((s) => s.state)
}

export function refetchLiveSession(): Promise<void> {
  return useLiveStore.getState().fetch()
}

/** Milliseconds since `startedAt`, ticking once per second while set. */
export function useElapsed(startedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (startedAt == null) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [startedAt])
  return startedAt == null ? 0 : Math.max(0, now - startedAt)
}
