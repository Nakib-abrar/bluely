/**
 * Pure DSP used inside the capture AudioWorklet: downmix to mono and stream-resample to
 * 16 kHz for Silero VAD + speech-to-text.
 *
 * No DOM, no allocations in the streaming hot path (`downmixInto`, `processInto`): this code
 * runs on the real-time audio thread, where GC pauses turn into audible/recorded glitches.
 */

/** Averages all channels into a new mono buffer. A single channel is copied. */
export function downmix(channels: Float32Array[]): Float32Array {
  const length = channels[0]?.length ?? 0
  const out = new Float32Array(length)
  downmixInto(channels, out, length)
  return out
}

/**
 * Non-allocating downmix: averages `length` samples of every channel into `out`.
 * Averaging (rather than summing) keeps full-scale stereo at full scale without clipping.
 */
export function downmixInto(channels: Float32Array[], out: Float32Array, length: number): void {
  const count = channels.length
  if (count === 0) {
    out.fill(0, 0, length)
    return
  }
  const first = channels[0] as Float32Array
  if (count === 1) {
    out.set(length === first.length ? first : first.subarray(0, length))
    return
  }
  const scale = 1 / count
  for (let i = 0; i < length; i++) {
    let sum = 0
    for (let c = 0; c < count; c++) sum += (channels[c] as Float32Array)[i] as number
    out[i] = sum * scale
  }
}

/** Sub-sample resolution of the precomputed filter bank (phases per input sample). */
const PHASES = 256
/** Stopband attenuation the Kaiser window is designed for. */
const STOPBAND_DB = 80
/** Cutoff (−6 dB point) as a fraction of the lower of the two rates (0.45 × 16 kHz = 7.2 kHz). */
const CUTOFF_RATIO = 0.45

/** Zeroth-order modified Bessel function of the first kind (series expansion). */
function besselI0(x: number): number {
  let sum = 1
  let term = 1
  const q = (x * x) / 4
  for (let k = 1; k < 64; k++) {
    term *= q / (k * k)
    sum += term
    if (term < sum * 1e-12) break
  }
  return sum
}

/**
 * Streaming band-limited resampler (windowed-sinc FIR, Kaiser window, ~80 dB stopband).
 *
 * - Downsampling: the anti-aliasing low-pass has its −6 dB point at 0.45 × outputRate and
 *   reaches the stopband at the output Nyquist frequency, so nothing folds back into speech.
 * - Fractional phase: a bank of PHASES+1 filter phases is precomputed (each normalised to
 *   unity DC gain) and the two nearest phases are linearly interpolated, which handles
 *   non-integer ratios such as 44.1 kHz → 16 kHz.
 * - State (input history and fractional position) is carried across `process` calls, so
 *   block boundaries are seamless: feeding a signal in one block or many gives the same output.
 * - Zero phase: output sample n is centred on input time n × inputRate / outputRate. The
 *   price is a fixed latency of `halfWidth` input samples (~1.6 ms at 48 kHz).
 * - inputRate === outputRate is an exact passthrough.
 */
export class Resampler {
  readonly inputRate: number
  readonly outputRate: number
  readonly passthrough: boolean
  /** Input samples advanced per output sample. */
  readonly step: number
  /** Half the filter length, in input samples. */
  readonly halfWidth: number
  private readonly taps: number
  /** (PHASES + 1) rows × taps coefficients, phase-major so each dot product is contiguous. */
  private readonly bank: Float32Array
  private hist: Float32Array
  private histLen = 0
  /** Position of the next output sample in `hist` coordinates (fractional). */
  private pos = 0

  constructor(inputRate: number, outputRate = 16_000) {
    if (!(inputRate > 0) || !Number.isFinite(inputRate)) {
      throw new RangeError(`Invalid input sample rate: ${inputRate}`)
    }
    if (!(outputRate > 0) || !Number.isFinite(outputRate)) {
      throw new RangeError(`Invalid output sample rate: ${outputRate}`)
    }
    this.inputRate = inputRate
    this.outputRate = outputRate
    this.passthrough = inputRate === outputRate
    this.step = inputRate / outputRate

    if (this.passthrough) {
      this.halfWidth = 0
      this.taps = 0
      this.bank = new Float32Array(0)
      this.hist = new Float32Array(0)
      return
    }

    const minRate = Math.min(inputRate, outputRate)
    const cutoff = (CUTOFF_RATIO * minRate) / inputRate // cycles per input sample
    // Transition band is symmetric around the cutoff and ends at the lower Nyquist frequency.
    const transition = (2 * (0.5 - CUTOFF_RATIO) * minRate) / inputRate
    const beta = 0.1102 * (STOPBAND_DB - 8.7)
    const length = Math.ceil((STOPBAND_DB - 8) / (2.285 * 2 * Math.PI * transition)) + 1
    this.halfWidth = Math.max(2, Math.ceil(length / 2))
    this.taps = 2 * this.halfWidth
    this.bank = buildBank(this.halfWidth, this.taps, cutoff, beta)

    this.hist = new Float32Array(this.taps + 4096)
    this.reset()
  }

  /** Upper bound on the number of output samples produced by one `process` of `inputLength`. */
  maxOutputLength(inputLength: number): number {
    if (this.passthrough) return inputLength
    return Math.ceil(inputLength / this.step) + 2
  }

  /** Latency introduced by the filter, in seconds. */
  get latencySec(): number {
    return this.halfWidth / this.inputRate
  }

  /** Clears the history (the next sample is treated as the start of a new stream). */
  reset(): void {
    if (this.passthrough) return
    // Virtual zeros before the first sample let output 0 be centred on input 0.
    this.hist.fill(0)
    this.histLen = this.halfWidth
    this.pos = this.halfWidth
  }

  /** Convenience (allocating) wrapper around `processInto`. */
  process(input: Float32Array): Float32Array {
    const out = new Float32Array(this.maxOutputLength(input.length))
    const count = this.processInto(input, out)
    return count === out.length ? out : out.slice(0, count)
  }

  /**
   * Resamples `inputLength` samples of `input` into `output` and returns how many output
   * samples were written. `output.length` must be ≥ `maxOutputLength(inputLength)`.
   * Allocates nothing unless a block larger than any previous one arrives.
   */
  processInto(input: Float32Array, output: Float32Array, inputLength = input.length): number {
    if (this.passthrough) {
      for (let i = 0; i < inputLength; i++) output[i] = input[i] as number
      return inputLength
    }
    this.ensureCapacity(this.histLen + inputLength)
    const hist = this.hist
    for (let i = 0; i < inputLength; i++) hist[this.histLen + i] = input[i] as number
    this.histLen += inputLength

    const { bank, taps, halfWidth, step } = this
    const histLen = this.histLen
    const maxOut = output.length
    let pos = this.pos
    let written = 0
    for (;;) {
      const ti = Math.floor(pos)
      if (ti + halfWidth >= histLen || written >= maxOut) break
      const phasePos = (pos - ti) * PHASES
      const phase = Math.floor(phasePos)
      const alpha = phasePos - phase
      const base = ti - halfWidth + 1
      const row0 = phase * taps
      let acc0 = 0
      for (let j = 0; j < taps; j++) acc0 += (hist[base + j] as number) * (bank[row0 + j] as number)
      if (alpha > 1e-9) {
        const row1 = row0 + taps
        let acc1 = 0
        for (let j = 0; j < taps; j++) {
          acc1 += (hist[base + j] as number) * (bank[row1 + j] as number)
        }
        acc0 += (acc1 - acc0) * alpha
      }
      output[written++] = acc0
      pos += step
    }

    // Drop history the next output no longer needs (keep from its first tap onwards).
    const keepFrom = Math.floor(pos) - halfWidth + 1
    if (keepFrom > 0) {
      const drop = Math.min(keepFrom, this.histLen)
      hist.copyWithin(0, drop, this.histLen)
      this.histLen -= drop
      pos -= drop
    }
    this.pos = pos
    return written
  }

  /**
   * Pushes `halfWidth` zeros through the filter so the tail of the stream comes out.
   * Used for offline conversion; the live pipeline never needs it (32 ms frames dominate).
   */
  flush(): Float32Array {
    if (this.passthrough) return new Float32Array(0)
    return this.process(new Float32Array(this.halfWidth + 1))
  }

  private ensureCapacity(needed: number): void {
    if (needed <= this.hist.length) return
    const grown = new Float32Array(Math.max(needed, this.hist.length * 2))
    grown.set(this.hist.subarray(0, this.histLen))
    this.hist = grown
  }
}

/**
 * Builds the polyphase bank. Row p holds the taps for an output centred p/PHASES of an
 * input sample after `ti`; tap j multiplies input `ti − halfWidth + 1 + j`.
 */
function buildBank(halfWidth: number, taps: number, cutoff: number, beta: number): Float32Array {
  const bank = new Float32Array((PHASES + 1) * taps)
  const i0Beta = besselI0(beta)
  const row = new Float64Array(taps)
  for (let p = 0; p <= PHASES; p++) {
    const frac = p / PHASES
    let sum = 0
    for (let j = 0; j < taps; j++) {
      const d = frac + halfWidth - 1 - j // distance from the output centre, in input samples
      const r = d / halfWidth
      const window = Math.abs(r) >= 1 ? 0 : besselI0(beta * Math.sqrt(1 - r * r)) / i0Beta
      const x = 2 * cutoff * d
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)
      const h = 2 * cutoff * sinc * window
      row[j] = h
      sum += h
    }
    // Unity DC gain for every phase avoids a ripple that would modulate with the phase.
    const norm = sum !== 0 ? 1 / sum : 0
    for (let j = 0; j < taps; j++) bank[p * taps + j] = (row[j] as number) * norm
  }
  return bank
}
