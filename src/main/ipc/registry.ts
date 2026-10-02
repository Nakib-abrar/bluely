import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent, type WebContents } from 'electron'
import {
  invokeContract,
  type InvokeChannel,
  type InvokeRequestParsed,
  type InvokeResponse,
  type IpcEnvelope,
} from '@shared/ipc'
import { AppError } from '../errors'
import type { Logger } from '../log'
import type { WindowKind, WindowRegistry } from '../windows/registry'

export interface HandlerContext {
  sender: WebContents
  window: BrowserWindow | null
  windowKind: WindowKind | null
}

export type Handler<C extends InvokeChannel> = (
  req: InvokeRequestParsed<C>,
  ctx: HandlerContext,
) => Promise<InvokeResponse<C>> | InvokeResponse<C>

let deps: { windows: WindowRegistry; log: Logger; isTrustedUrl: (url: string) => boolean } | null =
  null
const registered = new Set<string>()

export function initIpcRegistry(d: NonNullable<typeof deps>): void {
  deps = d
}

/**
 * Registers a zod-validated handler for an invoke channel. Requests from frames that are
 * not Bluely's own renderer pages are rejected.
 */
export function handle<C extends InvokeChannel>(channel: C, handler: Handler<C>): void {
  if (!deps) throw new Error('initIpcRegistry() must be called first')
  if (registered.has(channel)) throw new Error(`Duplicate IPC handler for ${channel}`)
  registered.add(channel)
  const schema = invokeContract[channel].req
  const { windows, log, isTrustedUrl } = deps

  ipcMain.handle(channel, async (event: IpcMainInvokeEvent, raw: unknown) => {
    const url = event.senderFrame?.url ?? ''
    if (!isTrustedUrl(url)) {
      log.warn(`Rejected IPC ${channel} from untrusted frame`, { url })
      return fail('forbidden', 'Untrusted sender')
    }
    const parsed = schema.safeParse(raw)
    if (!parsed.success) {
      log.warn(`Invalid payload for ${channel}`, parsed.error.issues.slice(0, 3))
      return fail('invalid_payload', `Invalid payload for ${channel}`)
    }
    const windowKind = windows.kindOf(event.sender)
    const ctx: HandlerContext = {
      sender: event.sender,
      window: windowKind ? windows.get(windowKind) : null,
      windowKind,
    }
    try {
      const data = await handler(parsed.data as InvokeRequestParsed<C>, ctx)
      return { ok: true, data } satisfies IpcEnvelope<unknown>
    } catch (err) {
      if (err instanceof AppError) {
        if (err.code !== 'aborted') log.warn(`${channel} failed: ${err.code} ${err.message}`)
        return {
          ok: false,
          error: { code: err.code, message: err.message, ...(err.ai ? { ai: err.ai } : {}) },
        } satisfies IpcEnvelope<unknown>
      }
      log.error(`${channel} threw`, err)
      return fail('internal', err instanceof Error ? err.message : 'Unexpected error')
    }
  })
}

function fail(code: string, message: string): IpcEnvelope<never> {
  return { ok: false, error: { code, message } }
}

/** Channels without a handler yet (used by tests and the dev console). */
export function unregisteredChannels(): InvokeChannel[] {
  return (Object.keys(invokeContract) as InvokeChannel[]).filter((c) => !registered.has(c))
}

/** For tests only. */
export function _resetRegistryForTests(): void {
  for (const c of registered) ipcMain.removeHandler(c)
  registered.clear()
}
