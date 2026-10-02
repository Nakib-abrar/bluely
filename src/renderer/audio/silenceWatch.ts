/**
 * "No system audio detected" rule. Pure (time is passed in), so it is unit-tested in Node.
 */
import { AUDIO } from '@shared/constants'
import { dbfsToRms } from './goertzel'

export interface NoSystemAudioOptions {
  /** Them frames quieter than this count as silence. */
  thresholdDbfs?: number
  /** How long Them must stay silent (while Me talks) before warning. */
  afterMs?: number
}

/**
 * Raises `no_system_audio` when the Them channel (desktop loopback) stays below −50 dBFS for
 * ≥ 20 s while the user (Me) spoke during that silence: the classic symptom of the call
 * playing on a device Windows does not loop back, or of a muted/wrong output device.
 * Them silence while nobody talks is normal (waiting room, muted call), so it never warns.
 * Clears as soon as Them audio returns.
 */
export class NoSystemAudioDetector {
  private readonly threshold: number
  private readonly afterMs: number
  private watching = false
  private lastThemAudioAt = 0
  private lastMeSpeechAt = Number.NEGATIVE_INFINITY
  private isActive = false

  constructor(opts: NoSystemAudioOptions = {}) {
    this.threshold = dbfsToRms(opts.thresholdDbfs ?? -50)
    this.afterMs = opts.afterMs ?? AUDIO.noSystemAudioAfterMs
  }

  get active(): boolean {
    return this.isActive
  }

  /** Them started listening: the silence window starts now. */
  start(now: number): void {
    this.watching = true
    this.lastThemAudioAt = now
    this.lastMeSpeechAt = Number.NEGATIVE_INFINITY
    this.isActive = false
  }

  /** Them is not capturing (stopped or failed); other warnings cover that case. */
  stop(): void {
    this.watching = false
    this.isActive = false
  }

  /** Feed every Them frame RMS. Returns the (possibly changed) active state. */
  themLevel(rms: number, now: number): boolean {
    if (!this.watching) return this.isActive
    if (rms >= this.threshold) {
      this.lastThemAudioAt = now
      this.isActive = false
      return false
    }
    return this.evaluate(now)
  }

  /** Call while the Me VAD reports speech. */
  meSpeech(now: number): boolean {
    this.lastMeSpeechAt = now
    return this.evaluate(now)
  }

  /** Re-evaluates at `now` (also useful from a timer). */
  evaluate(now: number): boolean {
    if (!this.watching) return this.isActive
    if (!this.isActive) {
      const silentFor = now - this.lastThemAudioAt
      const meSpokeDuringSilence = this.lastMeSpeechAt >= this.lastThemAudioAt
      this.isActive = silentFor >= this.afterMs && meSpokeDuringSilence
    }
    return this.isActive
  }
}

export interface DigitalSilenceOptions {
  /** Frames below this RMS count as digital silence (default −100 dBFS: exact zeros). */
  thresholdDbfs?: number
  /** How long the silence must last before it counts as muted. */
  afterMs?: number
}

/**
 * "Mic muted" from the signal itself. Windows' endpoint mute (and many hardware mute
 * buttons) keep the stream running but deliver exact zeros, which Chromium does not report
 * as a muted track. A live microphone always has some noise floor, even after noise
 * suppression, so ≥ 5 s of (near-)exact zeros means the user is muted.
 */
export class DigitalSilenceDetector {
  private readonly threshold: number
  private readonly afterMs: number
  private silentSince: number | null = null
  private isActive = false

  constructor(opts: DigitalSilenceOptions = {}) {
    this.threshold = dbfsToRms(opts.thresholdDbfs ?? -100)
    this.afterMs = opts.afterMs ?? 5000
  }

  get active(): boolean {
    return this.isActive
  }

  /** Feed every frame RMS; returns whether the input is currently "muted". */
  update(rms: number, now: number): boolean {
    if (rms >= this.threshold) {
      this.silentSince = null
      this.isActive = false
    } else {
      if (this.silentSince === null) this.silentSince = now
      this.isActive = now - this.silentSince >= this.afterMs
    }
    return this.isActive
  }

  reset(): void {
    this.silentSince = null
    this.isActive = false
  }
}
