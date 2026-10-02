import { KNOWLEDGE_LIMITS } from '@shared/constants'
import { knowledge } from '@shared/i18n/en/knowledge'

/**
 * English user-facing strings for Modes and knowledge files.
 *
 * WHY local: this slice does not own an i18n namespace. The object is shaped like a namespace in
 * src/shared/i18n/en/*.ts so it can move there verbatim and call sites can switch to
 * `t('knowledge.…')`. Failure reasons are stored in knowledge_files.error and shown as-is.
 */
/** Source of truth: src/shared/i18n/en/knowledge.ts. */
export const knowledgeMessages = knowledge

/** Replaces `{name}` placeholders (same syntax as the shared `t()`). */
export function fmt(template: string, vars: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (m, name: string) =>
    name in vars ? String(vars[name]) : m,
  )
}

const MB = 1024 * 1024

/** The fixed friendly reasons a knowledge file can fail with. */
export const reasons = {
  unsupportedType: knowledgeMessages.reasons.unsupportedType,
  tooLarge: fmt(knowledgeMessages.reasons.tooLarge, {
    mb: Math.round(KNOWLEDGE_LIMITS.maxFileBytes / MB),
  }),
  pdfNoText: knowledgeMessages.reasons.pdfNoText,
  pdfPassword: knowledgeMessages.reasons.pdfPassword,
  empty: knowledgeMessages.reasons.empty,
  modeFull: fmt(knowledgeMessages.reasons.modeFull, { max: KNOWLEDGE_LIMITS.maxFilesPerMode }),
  interrupted: knowledgeMessages.reasons.interrupted,
  unreadable: (detail: string) => fmt(knowledgeMessages.reasons.unreadable, { detail }),
} as const

/** A file could not be turned into knowledge; `reason` is friendly and safe to show the user. */
export class KnowledgeError extends Error {
  readonly reason: string

  constructor(reason: string, options?: { cause?: unknown }) {
    super(reason, options)
    this.name = 'KnowledgeError'
    this.reason = reason
  }
}
