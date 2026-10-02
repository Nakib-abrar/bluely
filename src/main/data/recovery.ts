import type { SessionSummary } from '@shared/types'
import type { SessionsRepo } from '../db/repos/sessionsRepo'
import type { TranscriptRepo } from '../db/repos/transcriptRepo'

/**
 * Finishes sessions a crash (or a kill during post-call processing) left 'active' or
 * 'processing'. Because transcript lines are committed as they arrive, everything said up to
 * the crash is still there; this reconstructs the end of the session and marks it 'recovered'
 * so the UI can offer "Generate notes?".
 *
 * - ended_at = started_at + end of the last transcript line (started_at when there are none).
 *   A 'processing' session already ended normally, so its stored ended_at is kept.
 * - Partial lines can no longer be revised, so they are promoted to final (and become
 *   searchable).
 *
 * Must run at startup before any live session begins. Returns the recovered sessions.
 */
export function recoverUnfinishedSessions(
  repos: { sessions: SessionsRepo; transcript: TranscriptRepo },
  nowMs: number,
): SessionSummary[] {
  const recovered: SessionSummary[] = []
  for (const s of repos.sessions.findUnfinished()) {
    repos.transcript.finalizeSession(s.id)
    let endedAt: number
    if (s.status === 'processing' && s.endedAt != null && s.endedAt >= s.startedAt) {
      endedAt = s.endedAt
    } else {
      const last = repos.transcript.lastLine(s.id)
      endedAt = s.startedAt + Math.max(0, last?.endMs ?? 0)
      // A clock that jumped backwards must not produce an end in the future.
      if (endedAt > nowMs && nowMs >= s.startedAt) endedAt = nowMs
    }
    repos.sessions.end(s.id, endedAt)
    repos.sessions.setStatus(s.id, 'recovered')
    const updated = repos.sessions.get(s.id)
    if (updated) recovered.push(updated)
  }
  return recovered
}
