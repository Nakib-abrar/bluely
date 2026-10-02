import type Database from 'better-sqlite3'
import type { Db } from '../db/database'
import type { Logger } from '../log'
import type { TranscriptionResult } from '../providers/stt/STTProvider'

/** Records one billed STT request. Never throws. */
export type SttUsageRecorder = (result: TranscriptionResult, sessionId: string | null) => void

type UsageRow = [
  createdAt: number,
  model: string,
  costUsd: number | null,
  audioSeconds: number | null,
  sessionId: string | null,
]

/**
 * Writes STT requests into `usage_log` (kind 'stt') for the monthly spend readout. Only the
 * cost, model and audio length are stored, never audio or text.
 */
export function createSttUsageRecorder(
  db: Db,
  log: Logger,
  now: () => number = Date.now,
): SttUsageRecorder {
  let insert: Database.Statement<UsageRow> | null = null
  return (result, sessionId) => {
    try {
      insert ??= db.prepare<UsageRow>(
        `INSERT INTO usage_log (created_at, kind, model, provider, cost_usd, audio_seconds, session_id)
         VALUES (?, 'stt', ?, NULL, ?, ?, ?)`,
      )
      insert.run(now(), result.model, result.costUsd, result.audioSeconds, sessionId)
    } catch (err) {
      // Spend tracking must never break transcription.
      log.warn('Could not record STT usage', err)
    }
  }
}
