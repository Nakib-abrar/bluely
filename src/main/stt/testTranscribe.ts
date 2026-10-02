import type { Settings } from '@shared/settings'
import { AppError } from '../errors'
import { ProviderError } from '../providers/errors'
import {
  cleanTranscript,
  hasSpeechContent,
  isLikelyHallucination,
} from '../providers/stt/hallucinations'
import type {
  STTProvider,
  TranscribeOptions,
  TranscriptionResult,
} from '../providers/stt/STTProvider'
import { isPcm16, parseWavHeader, pcm16Levels, SILENCE_RMS_THRESHOLD } from '../providers/stt/wav'

/** Settings › Test microphone sends ~5 s; this leaves room for 48 kHz stereo captures. */
export const MAX_TEST_WAV_BYTES = 8 * 1024 * 1024

export interface TestTranscriptionDeps {
  stt: STTProvider
  getSettings: () => Settings
  recordUsage: (result: TranscriptionResult) => void
  now?: () => number
}

export interface TestTranscriptionResult {
  /** Empty when no speech was detected (silent sample or text filtered as invented). */
  text: string
  latencyMs: number
  model: string
}

/** STT options for live transcription and the mic test, from the current settings. */
export function sttOptionsFromSettings(settings: Settings): TranscribeOptions {
  return { model: settings.models.stt.model, language: settings.language.transcription }
}

/**
 * Transcribes a mic-test sample exactly like a live segment (same model, language, silence
 * and hallucination filtering), so the test shows what a call would show. A silent sample
 * returns empty text without a network request.
 * Errors: AppError('invalid_audio'), or AppError(<ProviderErrorCode>, message, AiErrorInfo).
 */
export async function runTestTranscription(
  deps: TestTranscriptionDeps,
  wav: Uint8Array,
): Promise<TestTranscriptionResult> {
  if (wav.byteLength > MAX_TEST_WAV_BYTES) {
    throw new AppError('invalid_audio', 'Invalid WAV audio: sample is too large')
  }
  const header = parseWavHeader(wav)
  const options = sttOptionsFromSettings(deps.getSettings())
  const silent = { text: '', latencyMs: 0, model: options.model }
  let rms: number | null = null
  if (isPcm16(header)) {
    const levels = pcm16Levels(wav, header)
    if (levels.peakWindowRms < SILENCE_RMS_THRESHOLD) return silent
    rms = levels.rms
  }
  if (header.dataBytes === 0) return silent

  const endedAt = (deps.now ?? Date.now)()
  let result: TranscriptionResult
  try {
    result = await deps.stt.transcribe(
      {
        channel: 'me',
        wav,
        startedAt: endedAt - Math.round(header.durationSec * 1000),
        endedAt,
      },
      options,
    )
  } catch (err) {
    if (err instanceof ProviderError) throw new AppError(err.code, err.message, err.toInfo())
    throw err
  }
  deps.recordUsage(result)
  const text = cleanTranscript(result.text)
  const keep =
    hasSpeechContent(text) && !isLikelyHallucination(text, { durationSec: header.durationSec, rms })
  return { text: keep ? text : '', latencyMs: result.latencyMs, model: result.model }
}
