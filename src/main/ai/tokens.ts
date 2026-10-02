import type { ChatContentPart, ChatMessage } from '../providers/llm/LLMProvider'

/**
 * Cheap token estimates for prompt budgeting and dev logging.
 *
 * We deliberately avoid shipping a real tokenizer: every provider tokenizes differently and the
 * budget only needs to be roughly right. English averages ~4 characters per token; scripts such
 * as Bangla, CJK or emoji tokenize far worse, so each non-ASCII code point counts ~0.5 token.
 */

/** Rough cost of one attached image (most vision models land between 500 and 1100 tokens). */
export const IMAGE_TOKENS = 800
/** Per-message framing overhead (role markers, separators). */
export const MESSAGE_OVERHEAD_TOKENS = 4

/** Estimated token count of `text` (~chars/4 for ASCII, ~0.5 per non-ASCII character). */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let ascii = 0
  let other = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x80) ascii++
    // A surrogate pair is one code point: count only the high half.
    else if (c < 0xdc00 || c > 0xdfff) other++
  }
  return Math.ceil(ascii / 4 + other * 0.5)
}

function partTokens(part: ChatContentPart): number {
  return part.type === 'text' ? estimateTokens(part.text) : IMAGE_TOKENS
}

/** Estimated prompt tokens for a chat request (+4 per message, images ≈ 800). */
export function estimateMessagesTokens(messages: ChatMessage[]): number {
  let total = 0
  for (const m of messages) {
    total += MESSAGE_OVERHEAD_TOKENS
    if (typeof m.content === 'string') total += estimateTokens(m.content)
    else for (const part of m.content) total += partTokens(part)
  }
  return total
}

/**
 * Flattens messages into readable text for logs and `ai_messages.prompt_text`.
 * Images are replaced by a placeholder so base64 screenshots never end up in the database.
 */
export function messagesToText(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      const body =
        typeof m.content === 'string'
          ? m.content
          : m.content.map((p) => (p.type === 'text' ? p.text : '[image]')).join('\n\n')
      return `[${m.role}]\n${body}`
    })
    .join('\n\n')
}
