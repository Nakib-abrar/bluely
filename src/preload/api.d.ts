import type {
  EventChannel,
  EventPayload,
  InvokeChannel,
  IpcEnvelope,
  InvokeResponse,
} from '../shared/ipc'

export interface BluelyApi {
  /** Raw invoke. Use the typed wrapper in src/renderer/lib/ipc.ts instead. */
  invoke<C extends InvokeChannel>(
    channel: C,
    payload: unknown,
  ): Promise<IpcEnvelope<InvokeResponse<C>>>
  on<E extends EventChannel>(event: E, listener: (payload: EventPayload<E>) => void): () => void
  /** Resolves the absolute path of a dropped File (drag & drop knowledge uploads). */
  getPathForFile(file: File): string
  platform: string
}

declare global {
  interface Window {
    bluely: BluelyApi
  }
}
