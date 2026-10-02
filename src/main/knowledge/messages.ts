import { KNOWLEDGE_LIMITS } from '@shared/constants'

/**
 * English user-facing strings for Modes and knowledge files.
 *
 * WHY local: this slice does not own an i18n namespace. The object is shaped like a namespace in
 * src/shared/i18n/en/*.ts so it can move there verbatim and call sites can switch to
 * `t('knowledge.…')`. Failure reasons are stored in knowledge_files.error and shown as-is.
 */
export const knowledgeMessages = {
  reasons: {
    unsupportedType: 'Unsupported file type',
    tooLarge: 'File is larger than {mb} MB',
    pdfNoText: "This PDF has no extractable text (scanned PDFs aren't supported yet)",
    pdfPassword: 'This PDF is password-protected',
    unreadable: "Couldn't read this file: {detail}",
    empty: 'The file is empty',
    modeFull: 'This Mode already has {max} files',
    interrupted: 'Processing was interrupted. Remove the file and add it again.',
  },
  details: {
    notFound: 'file not found',
    permission: 'permission denied',
    busy: 'the file is in use by another app',
    notAFile: 'not a regular file',
    invalidPath: 'invalid path',
    invalidPdf: 'not a valid PDF',
    invalidDocx: 'not a valid Word document',
    unknown: 'unexpected error',
  },
  modes: {
    notFound: 'That Mode no longer exists.',
    builtinDelete: "Built-in Modes can't be deleted. You can reset them instead.",
    notBuiltin: 'Only built-in Modes can be reset.',
    invalid: 'Invalid Mode: {detail}',
  },
  dialog: {
    title: 'Add knowledge files',
    button: 'Add files',
    filterName: 'Documents',
  },
} as const

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
