/**
 * "Restart & update" from a main-window notice. Installing quits Bluely, and main refuses to
 * quit while a call runs or while the notes of one that just ended are being written (quitting
 * would abandon them). Pure apart from the injected session/updater calls (unit-tested in
 * tests/unit/mainui).
 */
import type { LiveStatus } from '@shared/types'

export interface InstallDeps {
  getStatus(): Promise<LiveStatus>
  /** Stops the call; resolves once it is stopped (also a stop that was already in progress). */
  stop(): Promise<void>
  /** Subscribes to session status changes; returns the unsubscribe function. */
  onStatus(listener: (status: LiveStatus) => void): () => void
  install(): Promise<void>
}

/** What "Restart to update" would cut short now: the call, or the notes of the last one. */
export function updateBlocker(status: LiveStatus): 'call' | 'notes' | null {
  if (status === 'starting' || status === 'live' || status === 'stopping') return 'call'
  if (status === 'processing') return 'notes'
  return null
}

/**
 * Resolves once no notes are being written for the call that just ended (the session leaves
 * 'processing'), or as soon as `signal` aborts.
 */
export function notesWritten(deps: InstallDeps, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false
    let off = () => {}
    const settle = (done: () => void) => {
      if (settled) return
      settled = true
      off()
      signal.removeEventListener('abort', onAbort)
      done()
    }
    const onAbort = () => settle(resolve)
    if (signal.aborted) return resolve()
    signal.addEventListener('abort', onAbort)
    // Subscribe before reading the status, so a change in between is not missed.
    off = deps.onStatus((status) => {
      if (status !== 'processing') settle(resolve)
    })
    deps.getStatus().then(
      (status) => {
        if (status !== 'processing') settle(resolve)
      },
      (err: unknown) => settle(() => reject(err)),
    )
  })
}

/**
 * Stops a running call (one that is starting, live or already stopping), lets the notes of the
 * call that just ended finish, then installs. Nothing is lost: the call is finalized and its
 * notes written before Bluely quits. Returns without installing when `signal` aborts first (the
 * user cancelled while waiting). If main still refuses (a new call started meanwhile), its
 * error is thrown for the caller to show.
 */
export async function installUpdate(deps: InstallDeps, signal: AbortSignal): Promise<void> {
  if (updateBlocker(await deps.getStatus()) === 'call') await deps.stop()
  if (signal.aborted) return
  await notesWritten(deps, signal)
  if (signal.aborted) return
  await deps.install()
}
