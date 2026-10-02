/** Schedules work for the next frame. */
export type FrameScheduler = (cb: () => void) => void

/**
 * Runs `cb` on the next animation frame, with a timer fallback. Chromium pauses
 * requestAnimationFrame while a window is hidden, and the overlay keeps receiving streamed
 * answers (and must keep reporting its size) while hidden, so a timer guarantees progress.
 */
export const nextFrame: FrameScheduler = (cb) => {
  let done = false
  const run = () => {
    if (done) return
    done = true
    cb()
  }
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run)
  setTimeout(run, 100)
}
