/**
 * AI slice: prompts, context assembly, post-call generation and the running summary.
 * Pure modules: they depend only on the LLMProvider interface and shared types (no IPC, no DB).
 */
export * from './contextBuilder'
export {
  MERGE_GAP_MS,
  PROMPT_SPEAKER,
  formatDateTime,
  formatDuration,
  formatTranscript,
  mergeTranscriptLines,
  usableLines,
  type TranscriptBlock,
} from './format'
export * from './json'
export * from './labels'
export * from './markdown'
export * from './postCall'
export * from './prompts'
export * from './runningSummary'
export * from './tokens'
