import { t } from '@shared/i18n'
import { models } from '@shared/i18n/en/models'

/**
 * User-facing strings produced by the models feature in the main process.
 * The source of truth is src/shared/i18n/en/models.ts; `modelMessage` goes through `t()`.
 */
export const MODEL_MESSAGES = models

export type ModelMessageKey = keyof typeof MODEL_MESSAGES

export function modelMessage(key: ModelMessageKey, vars?: Record<string, string | number>): string {
  return t(`models.${key}`, vars)
}
