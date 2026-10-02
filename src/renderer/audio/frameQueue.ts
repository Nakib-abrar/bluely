/**
 * Fixed-capacity ring buffers for the per-frame hot path (no allocation per frame). Pure.
 */

/**
 * Bounded FIFO of 16 kHz frames waiting for the VAD. When full, the oldest frame is dropped:
 * if inference falls behind (e.g. a busy machine), memory stays bounded and the pipeline
 * catches up with the newest audio rather than lagging further and further behind.
 */
export class FrameQueue {
  readonly capacity: number
  private readonly frames: (Float32Array | null)[]
  private readonly indices: Float64Array
  private head = 0
  private size = 0
  private dropped = 0
  private lastIndex = -1

  constructor(capacity: number) {
    if (!(capacity >= 1)) throw new RangeError('FrameQueue capacity must be ≥ 1')
    this.capacity = Math.floor(capacity)
    this.frames = new Array<Float32Array | null>(this.capacity).fill(null)
    this.indices = new Float64Array(this.capacity)
  }

  get length(): number {
    return this.size
  }

  /** Total frames dropped because the queue was full. */
  get droppedCount(): number {
    return this.dropped
  }

  /** Frame index of the frame most recently returned by `shift`. */
  get lastShiftedIndex(): number {
    return this.lastIndex
  }

  /** Enqueues a frame; returns true when an older frame had to be dropped to make room. */
  push(frame: Float32Array, index: number): boolean {
    let dropped = false
    if (this.size === this.capacity) {
      this.frames[this.head] = null
      this.head = (this.head + 1) % this.capacity
      this.size--
      this.dropped++
      dropped = true
    }
    const tail = (this.head + this.size) % this.capacity
    this.frames[tail] = frame
    this.indices[tail] = index
    this.size++
    return dropped
  }

  /** Dequeues the oldest frame (its index is then available as `lastShiftedIndex`). */
  shift(): Float32Array | null {
    if (this.size === 0) return null
    const frame = this.frames[this.head] ?? null
    this.lastIndex = this.indices[this.head] as number
    this.frames[this.head] = null
    this.head = (this.head + 1) % this.capacity
    this.size--
    return frame
  }

  clear(): void {
    this.frames.fill(null)
    this.head = 0
    this.size = 0
  }
}

/**
 * Remembers the indices of the last `capacity` frames handed to the VAD, so a finished
 * segment of N frames can be mapped back to its first frame's index even when frames were
 * dropped in between (dropped frames are simply not part of the segment audio).
 */
export class FrameIndexHistory {
  readonly capacity: number
  private readonly ring: Float64Array
  private count = 0

  constructor(capacity: number) {
    if (!(capacity >= 1)) throw new RangeError('FrameIndexHistory capacity must be ≥ 1')
    this.capacity = Math.floor(capacity)
    this.ring = new Float64Array(this.capacity)
  }

  get size(): number {
    return Math.min(this.count, this.capacity)
  }

  push(index: number): void {
    this.ring[this.count % this.capacity] = index
    this.count++
  }

  /**
   * Index of the n-th most recent frame (n = 1 is the latest). If n reaches beyond the
   * remembered window, extrapolates assuming contiguous frames. Returns -1 when empty.
   */
  fromEnd(n: number): number {
    if (this.count === 0) return -1
    const k = Math.max(1, Math.floor(n))
    const available = this.size
    if (k <= available) return this.ring[(this.count - k) % this.capacity] as number
    const oldest = this.ring[(this.count - available) % this.capacity] as number
    return oldest - (k - available)
  }

  clear(): void {
    this.count = 0
  }
}
