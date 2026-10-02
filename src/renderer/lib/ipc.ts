import type {
  EventChannel,
  EventPayload,
  InvokeChannel,
  InvokeRequest,
  InvokeResponse,
  IpcErrorPayload,
} from '@shared/ipc'
import type { AiErrorInfo } from '@shared/types'

export class IpcError extends Error {
  readonly code: string
  readonly ai: AiErrorInfo | undefined
  constructor(payload: IpcErrorPayload) {
    super(payload.ai?.message ?? payload.message)
    this.name = 'IpcError'
    this.code = payload.code
    this.ai = payload.ai
  }
}

type ArgsFor<C extends InvokeChannel> =
  undefined extends InvokeRequest<C> ? [payload?: InvokeRequest<C>] : [payload: InvokeRequest<C>]

/** Typed request to the main process. Throws IpcError on failure. */
export async function invoke<C extends InvokeChannel>(
  channel: C,
  ...args: ArgsFor<C>
): Promise<InvokeResponse<C>> {
  const envelope = await window.bluely.invoke(channel, args[0])
  if (envelope.ok) return envelope.data
  throw new IpcError(envelope.error)
}

/** Subscribes to a main → renderer event. Returns an unsubscribe function. */
export function on<E extends EventChannel>(
  event: E,
  listener: (payload: EventPayload<E>) => void,
): () => void {
  return window.bluely.on(event, listener)
}

export function errorMessage(err: unknown): string {
  if (err instanceof IpcError) return err.message
  if (err instanceof Error) return err.message
  return String(err)
}
