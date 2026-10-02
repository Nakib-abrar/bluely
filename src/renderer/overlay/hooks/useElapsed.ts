import { useEffect, useState } from 'react'

/** Milliseconds since `startedAt`, refreshed once per second (null while not started). */
export function useElapsed(startedAt: number | null, running: boolean): number | null {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (startedAt == null || !running) return
    // Align ticks to whole seconds of the session so the display never skips a second.
    let interval: ReturnType<typeof setInterval> | undefined
    const offset = 1000 - ((Date.now() - startedAt) % 1000)
    const timeout = setTimeout(() => {
      setNow(Date.now())
      interval = setInterval(() => setNow(Date.now()), 1000)
    }, offset)
    return () => {
      clearTimeout(timeout)
      if (interval) clearInterval(interval)
    }
  }, [startedAt, running])
  if (startedAt == null) return null
  return Math.max(0, now - startedAt)
}
