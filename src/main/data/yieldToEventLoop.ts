/**
 * Lets timers, IPC and window events run between two batches of synchronous work.
 * better-sqlite3 and fflate's sync API block the main process, which serves every window.
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}
