/**
 * Pure text formatting for settings results (unit-tested).
 */
import { t } from '@shared/i18n'
import type { AppInfo, KeyTestResult, MonthSpend } from '@shared/types'
import { formatUsd } from '../../lib/format'
import { formatMs } from './models'

/** "Connected · $16.79 remaining of $20.00 · 210 ms" */
export function describeKeyTest(r: KeyTestResult): string {
  const parts: string[] = [t('settings.key.connected')]
  if (r.limit != null && r.remaining != null) {
    parts.push(
      t('settings.key.remaining', { remaining: formatUsd(r.remaining), limit: formatUsd(r.limit) }),
    )
  } else if (r.usage != null) {
    parts.push(t('settings.key.used', { usage: formatUsd(r.usage) }))
  }
  if (r.isFreeTier) parts.push(t('settings.key.freeTier'))
  if (r.latencyMs != null) parts.push(formatMs(r.latencyMs))
  return parts.join(' · ')
}

/** { total: "$0.42 this month", detail: "LLM $0.31 · Transcription $0.11 · 128 requests" } */
export function describeSpend(s: MonthSpend): { total: string; detail: string } {
  return {
    total: t('settings.models.spendTotal', { total: formatUsd(s.totalUsd) }),
    detail: t('settings.models.spendDetail', {
      llm: formatUsd(s.llmUsd),
      stt: formatUsd(s.sttUsd),
      requests: s.requests.toLocaleString('en-US'),
    }),
  }
}

/** Counts user-perceived characters (an emoji with modifiers counts as one). */
export function graphemeCount(text: string): number {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].length
  }
  return [...text].length
}

/** A Mode icon is valid when it is 1–2 visible characters (and fits the 16-char schema limit). */
export function isValidModeIcon(icon: string): boolean {
  const trimmed = icon.trim()
  if (!trimmed || trimmed.length > 16) return false
  return graphemeCount(trimmed) <= 2
}

/** App info block for bug reports (Settings › Help › Copy app info). */
export function formatAppInfo(info: AppInfo): string {
  const flags = [info.isPortable ? 'portable' : null, info.isPackaged ? null : 'dev']
    .filter(Boolean)
    .join(', ')
  return [
    `${info.name} ${info.version}${flags ? ` (${flags})` : ''}`,
    `Electron ${info.electron} · Chrome ${info.chrome}`,
    `Platform ${info.platform} ${info.arch}`,
  ].join('\n')
}
