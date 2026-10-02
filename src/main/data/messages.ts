/**
 * User-facing strings of the history/data feature. Source of truth: src/shared/i18n/en/history.ts.
 */
import { t } from '@shared/i18n'
import { history } from '@shared/i18n/en/history'
export { history }

export type HistoryMessageKey = keyof typeof history

/** Same contract as the shared `t()`: `{name}` placeholders are replaced from `vars`. */
export function ht(key: HistoryMessageKey, vars?: Record<string, string | number>): string {
  return t(`history.${key}`, vars)
}
