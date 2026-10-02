/**
 * Messages between the 'bluely-capture' AudioWorkletProcessor and the page. Types only.
 */

/** Name the processor is registered under. */
export const CAPTURE_PROCESSOR_NAME = 'bluely-capture'

/** Page → worklet. */
export type CaptureWorkletCommand = { type: 'stop' }

/** First message: when (in AudioContext time) the first 16 kHz sample was produced. */
export interface CaptureStartedMessage {
  type: 'started'
  /** AudioContext time (s) at the start of the first processed render quantum. */
  contextTime: number
  /** Input (context) sample rate the worklet resamples from. */
  inputSampleRate: number
}

/** One 512-sample, 16 kHz mono frame. `frame`'s buffer is transferred (not copied). */
export interface CaptureFrameMessage {
  type: 'frame'
  frame: Float32Array
  /** RMS of the frame (linear, 1.0 = full scale). */
  rms: number
  /** 0-based frame counter since the worklet started. */
  index: number
}

export type CaptureWorkletMessage = CaptureStartedMessage | CaptureFrameMessage
