import { useEffect, useRef } from 'react'
import type { EventChannel, EventPayload } from '@shared/ipc'
import { on } from '../lib/ipc'

/** Subscribes to a main-process event for the lifetime of the component. */
export function useIpcEvent<E extends EventChannel>(
  event: E,
  handler: (payload: EventPayload<E>) => void,
): void {
  const ref = useRef(handler)
  useEffect(() => {
    ref.current = handler
  })
  useEffect(() => on(event, (p) => ref.current(p)), [event])
}
