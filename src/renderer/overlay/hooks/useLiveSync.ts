import { useEffect } from 'react'
import { invoke, on } from '../../lib/ipc'
import { forgetIfDeleted, receiveLiveCard } from '../actions'
import { useLive } from '../stores/liveStore'
import { useUi } from '../stores/uiStore'

function logWarn(message: string) {
  invoke('app:rendererLog', { level: 'warn', message: message.slice(0, 4000) }).catch(
    () => undefined,
  )
}

/**
 * Keeps the live store in sync with main: initial state on mount, then session, transcript,
 * card and latency events. Loads the transcript and cards whenever a new session appears,
 * and drops them when that meeting is deleted from History.
 */
export function useLiveSync(): void {
  useEffect(() => {
    const live = useLive.getState()
    const ui = useUi.getState()
    let disposed = false
    const offs = [
      on('session:state', (s) => {
        const prev = useLive.getState().state.sessionId
        if (s.sessionId && s.sessionId !== prev) useUi.getState().resetSessionUi()
        live.setState(s)
      }),
      on('transcript:line', (l) => live.upsertLine(l)),
      on('transcript:remove', (p) => live.removeLine(p.id, p.sessionId)),
      on('ai:card', (c) => receiveLiveCard(c)),
      on('ai:delta', (p) => live.appendDelta(p.id, p.delta)),
      on('ai:done', (p) => live.finishCard(p.id, p.text, p.stats)),
      on('ai:error', (p) => live.failCard(p.id, p.error)),
      on('ai:cancelled', (p) => live.cancelCard(p.id)),
      on('ai:stats', (p) => live.setStats(p.id, p.stats)),
      on('ai:cleared', (p) => {
        if (p.scope === 'live') live.clearCards()
      }),
      on('dev:latency', (trace) => live.addTrace(trace)),
      on('overlay:visibility', (v) => ui.setExpanded(v.expanded)),
      on('sessions:changed', (p) => void forgetIfDeleted(p.id)),
    ]
    invoke('session:getState')
      .then((s) => {
        if (!disposed) live.setState(s)
      })
      .catch((err: unknown) => logWarn(`overlay: session:getState failed: ${String(err)}`))
    return () => {
      disposed = true
      for (const off of offs) off()
    }
  }, [])

  const sessionId = useLive((s) => s.state.sessionId)
  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    const live = useLive.getState()
    invoke('session:getTranscript', { sessionId })
      .then((lines) => {
        if (!cancelled) live.mergeTranscript(sessionId, lines)
      })
      .catch((err: unknown) => logWarn(`overlay: getTranscript failed: ${String(err)}`))
    invoke('ai:getCards', { scope: 'live', sessionId })
      .then((cards) => {
        if (!cancelled) live.mergeCards(cards)
      })
      .catch((err: unknown) => logWarn(`overlay: ai:getCards failed: ${String(err)}`))
    return () => {
      cancelled = true
    }
  }, [sessionId])
}
