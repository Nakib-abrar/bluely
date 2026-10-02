/**
 * Batches streamed text deltas so renderers get at most one IPC message per card every
 * `intervalMs`. Keeps streaming smooth without flooding IPC with single-token messages.
 */
export class DeltaCoalescer {
  private pending = new Map<string, string>()
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly flushFn: (id: string, delta: string) => void,
    private readonly intervalMs = 30,
  ) {}

  push(id: string, delta: string): void {
    this.pending.set(id, (this.pending.get(id) ?? '') + delta)
    if (!this.timer) this.timer = setTimeout(() => this.flushAll(), this.intervalMs)
  }

  /** Flushes one card immediately (call before sending its 'done'/'error'). */
  flush(id: string): void {
    const text = this.pending.get(id)
    if (text) this.flushFn(id, text)
    this.pending.delete(id)
  }

  flushAll(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    for (const [id, text] of this.pending) if (text) this.flushFn(id, text)
    this.pending.clear()
  }
}
