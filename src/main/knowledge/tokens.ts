/**
 * Cheap, tokenizer-free token estimates used to size knowledge chunks.
 *
 * WHY a heuristic: chunk sizes only need to be roughly right, the real tokenizer depends on the
 * model the user picks, and bundling one would cost megabytes. English BPE tokenizers average
 * ~4 characters per token; scripts outside ASCII (Bangla, CJK, accented text) are split much more
 * finely, so each non-ASCII character counts as half a token.
 */

const ASCII_CHARS_PER_TOKEN = 4
const NON_ASCII_TOKENS_PER_CHAR = 0.5

/** Weight of one UTF-16 code unit. A surrogate pair counts once (on its high half). */
export function codeUnitWeight(code: number): number {
  if (code < 0x80) return 1 / ASCII_CHARS_PER_TOKEN
  if (code >= 0xdc00 && code <= 0xdfff) return 0
  return NON_ASCII_TOKENS_PER_CHAR
}

/**
 * Fractional token estimate. Additive over concatenation, so callers can sum the weights of
 * pieces without rounding drift (the chunker relies on this).
 */
export function tokenWeight(text: string): number {
  let ascii = 0
  let other = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x80) ascii++
    else if (code < 0xdc00 || code > 0xdfff) other++
  }
  return ascii / ASCII_CHARS_PER_TOKEN + other * NON_ASCII_TOKENS_PER_CHAR
}

/** Estimated token count (~4 ASCII chars per token, ~0.5 token per non-ASCII char), rounded up. */
export function estimateTokens(text: string): number {
  return Math.ceil(tokenWeight(text))
}
