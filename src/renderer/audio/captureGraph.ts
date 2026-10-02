/**
 * Web Audio plumbing shared by the live pipeline, the mic test and the system audio test:
 * MediaStream → AudioContext (at the device rate) → 'bluely-capture' worklet → 16 kHz frames.
 */
import workletUrl from './worklets/capture.worklet.ts?worker&url'
import { CAPTURE_PROCESSOR_NAME, type CaptureWorkletMessage } from './worklets/protocol'

export interface CaptureGraphHandlers {
  /** One 512-sample 16 kHz mono frame (owned by the receiver) with its RMS and index. */
  onFrame(frame: Float32Array, rms: number, index: number): void
  /** The worklet processed its first render quantum (context time of sample 0). */
  onStarted?(info: CaptureStartedInfo): void
}

export interface CaptureStartedInfo {
  /** AudioContext time (s) of the first 16 kHz sample. */
  contextTime: number
  inputSampleRate: number
  /**
   * A (Date.now(), AudioContext.currentTime) pair read together when the message arrived;
   * maps context time to wall time without the worklet → page message delay.
   */
  anchor: { epochMs: number; contextTime: number }
}

export interface CaptureGraph {
  readonly context: AudioContext
  /** Context (= device) sample rate the worklet resamples from. */
  readonly sampleRate: number
  /** A simultaneous (epoch ms, AudioContext time) pair for SegmentClock anchoring. */
  timestamp(): { epochMs: number; contextTime: number }
  /** Stops the worklet and closes the AudioContext. Safe to call twice. */
  close(): Promise<void>
}

/** Chromium accepts `sinkId: { type: 'none' }` (not yet in TypeScript's DOM lib). */
type ContextOptions = AudioContextOptions & { sinkId?: string | { type: 'none' } }

/** Sample rate the device delivers, if the browser reports it. */
export function streamSampleRate(stream: MediaStream): number | undefined {
  const track = stream.getAudioTracks()[0]
  const rate = track?.getSettings().sampleRate
  return typeof rate === 'number' && rate >= 8000 && rate <= 384_000 ? rate : undefined
}

/**
 * Creates a capture-only AudioContext. `sinkId: { type: 'none' }` renders without opening an
 * output device: capture keeps running when the default speaker/headset changes or
 * disappears, and Bluely does not show up as an audio-playing app. 'playback' latency means
 * fewer, larger audio callbacks (lower idle CPU); VAD latency is dominated by the 400 ms pause.
 */
function createCaptureContext(sampleRate: number | undefined): AudioContext {
  const base: ContextOptions = { latencyHint: 'playback' }
  if (sampleRate) base.sampleRate = sampleRate
  const attempts: ContextOptions[] = [{ ...base, sinkId: { type: 'none' } }, base, {}]
  let lastError: unknown = null
  for (const options of attempts) {
    try {
      return new AudioContext(options)
    } catch (err) {
      lastError = err
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Could not create an AudioContext')
}

/** Wires `stream` into a new AudioContext + capture worklet and starts delivering frames. */
export async function openCaptureGraph(
  stream: MediaStream,
  handlers: CaptureGraphHandlers,
): Promise<CaptureGraph> {
  const context = createCaptureContext(streamSampleRate(stream))
  let closed = false
  try {
    await context.audioWorklet.addModule(workletUrl)
    const source = new MediaStreamAudioSourceNode(context, { mediaStream: stream })
    // No outputs: Chromium pulls output-less worklet nodes automatically, so nothing is
    // routed to the destination (no echo, no output processing).
    const node = new AudioWorkletNode(context, CAPTURE_PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCountMode: 'max',
    })
    node.port.onmessage = (event: MessageEvent<CaptureWorkletMessage>) => {
      if (closed) return
      const msg = event.data
      if (msg.type === 'frame') handlers.onFrame(msg.frame, msg.rms, msg.index)
      else if (msg.type === 'started') {
        handlers.onStarted?.({
          contextTime: msg.contextTime,
          inputSampleRate: msg.inputSampleRate,
          anchor: { epochMs: Date.now(), contextTime: context.currentTime },
        })
      }
    }
    source.connect(node)
    if (context.state !== 'running') await context.resume()

    return {
      context,
      sampleRate: context.sampleRate,
      timestamp() {
        // Date.now() (not performance.timeOrigin + now()) so segment times share main's
        // clock. currentTime advances per audio callback, so a single pair is only accurate
        // to one callback period; the pipeline smooths repeated anchors.
        return { epochMs: Date.now(), contextTime: context.currentTime }
      },
      async close() {
        if (closed) return
        closed = true
        node.port.onmessage = null
        try {
          node.port.postMessage({ type: 'stop' })
          source.disconnect()
        } catch {
          // Already torn down.
        }
        await context.close().catch(() => undefined)
      },
    }
  } catch (err) {
    closed = true
    await context.close().catch(() => undefined)
    throw err
  }
}
