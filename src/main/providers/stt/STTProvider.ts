import type { Channel } from '@shared/types'

/**
 * Speech-to-text interface. v1 uses segment-based transcription (VAD cuts speech into
 * segments, each is transcribed). Streaming providers (Deepgram, AssemblyAI, Gemini Live,
 * local Whisper) can implement `openStream` to deliver partial → final results; the UI
 * already updates transcript lines in place by id.
 */

export interface AudioSegment {
  channel: Channel
  /** 16 kHz mono 16-bit PCM WAV bytes. */
  wav: Uint8Array
  /** Epoch ms. */
  startedAt: number
  endedAt: number
}

export interface TranscribeOptions {
  model: string
  /** ISO-639-1 code, or null/undefined for auto-detect. */
  language?: string | null
  signal?: AbortSignal
}

export interface TranscriptionResult {
  text: string
  model: string
  /** Request round-trip time. */
  latencyMs: number
  costUsd: number | null
  audioSeconds: number | null
  language: string | null
}

export interface StreamingSttResult {
  /** Stable id: partials and the final result for the same utterance share it. */
  id: string
  channel: Channel
  text: string
  isFinal: boolean
  startedAt: number
  endedAt: number
}

export interface StreamingSttSession {
  /** Feeds 16 kHz mono PCM samples. */
  write(samples: Int16Array): void
  onResult(cb: (r: StreamingSttResult) => void): () => void
  close(): Promise<void>
}

export interface STTProvider {
  readonly id: string
  readonly supportsStreaming: boolean
  transcribe(segment: AudioSegment, opts: TranscribeOptions): Promise<TranscriptionResult>
  openStream?(opts: {
    channel: Channel
    model: string
    language?: string | null
  }): StreamingSttSession
}
