/**
 * Canonical (NFC) form for every text column the search index reads. Queries are NFC-normalized
 * (search.ts tokenize), and FTS5's unicode61 tokenizer compares code points without any Unicode
 * normalization, so text stored in another form would never match: Bangla য়/ড়/ঢ় are composition
 * exclusions, and the precomposed U+09DF that STT or the notes model may emit becomes
 * U+09AF U+09BC under NFC.
 */
export function toNfc(text: string): string {
  return text.normalize('NFC')
}
