import type { ModelStat, MonthSpend } from '@shared/types'
import type { Db } from '../db/database'
import { percentile } from './percentiles'

/** Rolling window size per (model, provider). */
export const STATS_WINDOW = 50

export interface LatencySample {
  ttftMs: number | null
  totalMs: number
  tokensPerSec: number | null
  /** Epoch ms when recorded. */
  at: number
}

export interface RecordSampleInput {
  /** The model id the user selected (stable key for Settings › AI Models). */
  model: string
  /** Serving provider as reported by OpenRouter (e.g. "Groq"); null when unknown. */
  provider: string | null
  ttftMs: number | null
  totalMs: number
  tokensPerSec: number | null
}

export interface UsageEntry {
  kind: 'llm' | 'stt'
  model?: string | null
  provider?: string | null
  costUsd?: number | null
  tokensIn?: number | null
  tokensOut?: number | null
  audioSeconds?: number | null
  sessionId?: string | null
}

interface StatRow {
  model: string
  provider: string
  samples: number
  ttft_p50: number | null
  ttft_p90: number | null
  total_p50: number | null
  tps_p50: number | null
  recent_json: string
  updated_at: number
}

const finiteOrNull = (v: number | null | undefined): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null

const nonNegOrNull = (v: number | null | undefined): number | null => {
  const n = finiteOrNull(v)
  return n !== null && n >= 0 ? n : null
}

const intOrNull = (v: number | null | undefined): number | null => {
  const n = nonNegOrNull(v)
  return n === null ? null : Math.round(n)
}

/** Summarises samples into a ModelStat (nearest-rank p50/p90). Pure. */
export function summarizeSamples(
  model: string,
  provider: string | null,
  samples: readonly LatencySample[],
  updatedAt: number,
): ModelStat {
  const ttfts = samples.map((s) => s.ttftMs).filter((v): v is number => v !== null)
  const totals = samples.map((s) => s.totalMs)
  const tps = samples.map((s) => s.tokensPerSec).filter((v): v is number => v !== null)
  return {
    model,
    provider,
    samples: samples.length,
    ttftP50: percentile(ttfts, 50),
    ttftP90: percentile(ttfts, 90),
    totalP50: percentile(totals, 50),
    tokensPerSecP50: percentile(tps, 50),
    updatedAt,
  }
}

function parseRecent(json: string): LatencySample[] {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  const out: LatencySample[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const totalMs = typeof r['totalMs'] === 'number' ? nonNegOrNull(r['totalMs']) : null
    if (totalMs === null) continue
    out.push({
      ttftMs: typeof r['ttftMs'] === 'number' ? nonNegOrNull(r['ttftMs']) : null,
      totalMs,
      tokensPerSec: typeof r['tokensPerSec'] === 'number' ? nonNegOrNull(r['tokensPerSec']) : null,
      at: typeof r['at'] === 'number' ? r['at'] : 0,
    })
  }
  return out
}

/** First millisecond of the local calendar month containing `nowMs`. */
export function startOfLocalMonth(nowMs: number): number {
  const d = new Date(nowMs)
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0).getTime()
}

/**
 * Per-model latency statistics (model_stats, rolling window of the last 50 samples per
 * model + provider) and the per-request usage/cost log (usage_log).
 */
export class ModelStatsRepo {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  /** Adds one measurement and recomputes the row's percentiles. Returns the updated stat. */
  recordSample(input: RecordSampleInput): ModelStat {
    const providerKey = input.provider?.trim() ?? ''
    const at = this.now()
    const sample: LatencySample = {
      ttftMs: nonNegOrNull(input.ttftMs),
      totalMs: nonNegOrNull(input.totalMs) ?? 0,
      tokensPerSec: nonNegOrNull(input.tokensPerSec),
      at,
    }
    const tx = this.db.transaction((): ModelStat => {
      const row = this.db
        .prepare('SELECT recent_json FROM model_stats WHERE model = ? AND provider = ?')
        .get(input.model, providerKey) as { recent_json: string } | undefined
      const recent = [...(row ? parseRecent(row.recent_json) : []), sample].slice(-STATS_WINDOW)
      const stat = summarizeSamples(input.model, providerKey || null, recent, at)
      this.db
        .prepare(
          `INSERT INTO model_stats(model, provider, samples, ttft_p50, ttft_p90, total_p50, tps_p50, recent_json, updated_at)
           VALUES (@model, @provider, @samples, @ttftP50, @ttftP90, @totalP50, @tpsP50, @recent, @updatedAt)
           ON CONFLICT(model, provider) DO UPDATE SET
             samples = excluded.samples, ttft_p50 = excluded.ttft_p50, ttft_p90 = excluded.ttft_p90,
             total_p50 = excluded.total_p50, tps_p50 = excluded.tps_p50,
             recent_json = excluded.recent_json, updated_at = excluded.updated_at`,
        )
        .run({
          model: input.model,
          provider: providerKey,
          samples: stat.samples,
          ttftP50: stat.ttftP50,
          ttftP90: stat.ttftP90,
          totalP50: stat.totalP50,
          tpsP50: stat.tokensPerSecP50,
          recent: JSON.stringify(recent),
          updatedAt: at,
        })
      return stat
    })
    return tx()
  }

  /** One row per (model, provider), most recently updated first. */
  list(): ModelStat[] {
    const rows = this.db
      .prepare('SELECT * FROM model_stats ORDER BY updated_at DESC, model, provider')
      .all() as StatRow[]
    return rows.map((r) => ({
      model: r.model,
      provider: r.provider || null,
      samples: r.samples,
      ttftP50: r.ttft_p50,
      ttftP90: r.ttft_p90,
      totalP50: r.total_p50,
      tokensPerSecP50: r.tps_p50,
      updatedAt: r.updated_at,
    }))
  }

  /**
   * One aggregate per model across all providers (the newest STATS_WINDOW samples overall).
   * `provider` is set only when every sample came from the same provider.
   */
  listByModel(): ModelStat[] {
    const rows = this.db
      .prepare('SELECT model, provider, recent_json, updated_at FROM model_stats')
      .all() as Pick<StatRow, 'model' | 'provider' | 'recent_json' | 'updated_at'>[]
    const groups = new Map<
      string,
      { providers: Set<string>; samples: LatencySample[]; updatedAt: number }
    >()
    for (const r of rows) {
      const g = groups.get(r.model) ?? { providers: new Set(), samples: [], updatedAt: 0 }
      g.providers.add(r.provider)
      g.samples.push(...parseRecent(r.recent_json))
      g.updatedAt = Math.max(g.updatedAt, r.updated_at)
      groups.set(r.model, g)
    }
    const out: ModelStat[] = []
    for (const [model, g] of groups) {
      const newest = [...g.samples].sort((a, b) => a.at - b.at).slice(-STATS_WINDOW)
      const only = g.providers.size === 1 ? [...g.providers][0] : undefined
      out.push(summarizeSamples(model, only ? only : null, newest, g.updatedAt))
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt || (a.model < b.model ? -1 : 1))
  }

  get(model: string, provider: string | null): ModelStat | null {
    return this.list().find((s) => s.model === model && s.provider === (provider || null)) ?? null
  }

  /** Appends one request to usage_log (cost is what OpenRouter reported). */
  logUsage(entry: UsageEntry): void {
    this.db
      .prepare(
        `INSERT INTO usage_log(created_at, kind, model, provider, cost_usd, tokens_in, tokens_out, audio_seconds, session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.now(),
        entry.kind,
        entry.model ?? null,
        entry.provider ?? null,
        nonNegOrNull(entry.costUsd),
        intOrNull(entry.tokensIn),
        intOrNull(entry.tokensOut),
        nonNegOrNull(entry.audioSeconds),
        entry.sessionId ?? null,
      )
  }

  /** Spend since the first day of the current local month, split into LLM and STT. */
  monthSpend(nowMs: number = this.now()): MonthSpend {
    const sinceMs = startOfLocalMonth(nowMs)
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(cost_usd), 0) AS total,
                COALESCE(SUM(CASE WHEN kind = 'llm' THEN cost_usd END), 0) AS llm,
                COALESCE(SUM(CASE WHEN kind = 'stt' THEN cost_usd END), 0) AS stt,
                COUNT(*) AS requests
           FROM usage_log WHERE created_at >= ?`,
      )
      .get(sinceMs) as { total: number; llm: number; stt: number; requests: number }
    return {
      sinceMs,
      totalUsd: row.total,
      llmUsd: row.llm,
      sttUsd: row.stt,
      requests: row.requests,
    }
  }
}
