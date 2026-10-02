import type { Statement } from 'better-sqlite3'
import type { KnowledgeSnippet } from '@shared/types'
import type { Db } from '../db/database'
import type { Logger } from '../log'
import { STOPWORDS } from './stopwords'

/**
 * Finds the knowledge chunks of a Mode that best match a free-text query.
 *
 * v1 ships `Fts5Retriever` (BM25 over SQLite FTS5, no embeddings). The interface is deliberately
 * synchronous and storage-agnostic so other strategies can slot in later:
 *
 * - `EmbeddingRetriever` would embed every chunk at ingest time (a `knowledge_embeddings(chunk_id,
 *   model, vector BLOB)` table filled by `KnowledgeService` after the chunk insert), keep the
 *   vectors of the active Mode in memory as a Float32Array matrix, embed the query and return the
 *   top-k chunks by cosine similarity. Because embedding the query needs a network call, it would
 *   precompute the query vector when a Them utterance arrives (or expose an async
 *   `prepare(query)`) so `search()` itself stays synchronous and fast on the hot path.
 * - A hybrid retriever would call both, normalize the scores (or use reciprocal-rank fusion:
 *   Σ 1 / (60 + rank)) and merge by chunk (fileId + chunkIdx).
 *
 * Scores are "higher is better" and only comparable within one result list.
 */
export interface Retriever {
  search(modeId: string, query: string, k: number): KnowledgeSnippet[]
}

/** Maximum number of terms in a MATCH query; long utterances are trimmed to the most specific. */
export const MAX_QUERY_TERMS = 16
/** Upper bound for `k` so a bad caller cannot pull the whole knowledge base into a prompt. */
const MAX_RESULTS = 50

/** Longer "words" are hashes, URLs or base64 rather than language; they never help ranking. */
const MAX_TERM_LENGTH = 64
/** FTS5 operators; harmless inside quotes, but they are never useful as search terms either. */
const FTS_OPERATORS = new Set(['and', 'or', 'not', 'near'])

/**
 * Extracts search terms from free text: lower-cased, NFC-normalized, letters/digits/combining
 * marks only (everything else, including FTS5 syntax such as `"`, `*`, `:`, `^`, `(`, `-`, `+`,
 * becomes a separator), FTS5 operators, stopwords and implausibly long tokens dropped, deduplicated, at most
 * `MAX_QUERY_TERMS` (the longest, i.e. most specific, terms win; ties favour later, i.e. more
 * recent, words).
 */
export function extractQueryTerms(text: string): string[] {
  const words = text
    .normalize('NFC')
    .toLowerCase()
    // Combining marks (\p{M}) are part of words in Bangla and other Indic scripts.
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
    .split(' ')
  const seen = new Set<string>()
  const terms: { term: string; pos: number }[] = []
  words.forEach((word, pos) => {
    // A word must contain a letter or digit (a stray combining mark is not a word).
    if (!/[\p{L}\p{N}]/u.test(word)) return
    // Single ASCII letters ("a", the "s" of "what's") only add noise as prefix queries.
    if (/^[a-z]$/.test(word) || word.length > MAX_TERM_LENGTH) return
    if (FTS_OPERATORS.has(word) || STOPWORDS.has(word) || seen.has(word)) return
    seen.add(word)
    terms.push({ term: word, pos })
  })
  if (terms.length <= MAX_QUERY_TERMS) return terms.map((t) => t.term)
  return terms
    .slice()
    .sort((a, b) => b.term.length - a.term.length || b.pos - a.pos)
    .slice(0, MAX_QUERY_TERMS)
    .sort((a, b) => a.pos - b.pos)
    .map((t) => t.term)
}

/**
 * Builds a safe FTS5 MATCH expression (`"term1"* OR "term2"* …`) from free text, or null when
 * nothing searchable is left. Terms only contain letters, digits and combining marks, so quoting
 * them can never produce an FTS5 syntax error.
 */
export function buildMatchQuery(text: string): string | null {
  const terms = extractQueryTerms(text)
  if (!terms.length) return null
  return terms.map((t) => `"${t}"*`).join(' OR ')
}

interface SnippetRow {
  fileId: string
  filename: string
  chunkIdx: number
  text: string
  bm25Score: number
}

/** BM25 retrieval over `knowledge_chunks_fts`, restricted to one Mode's successfully parsed files. */
export class Fts5Retriever implements Retriever {
  private readonly stmt: Statement<[string, string, number], SnippetRow>

  constructor(
    private readonly db: Db,
    private readonly log?: Logger,
  ) {
    this.stmt = this.db.prepare<[string, string, number], SnippetRow>(`
      SELECT c.file_id AS fileId, f.filename AS filename, c.idx AS chunkIdx, c.text AS text,
             bm25(knowledge_chunks_fts) AS bm25Score
      FROM knowledge_chunks_fts
      JOIN knowledge_chunks c ON c.id = knowledge_chunks_fts.rowid
      JOIN knowledge_files f ON f.id = c.file_id
      WHERE knowledge_chunks_fts MATCH ? AND f.mode_id = ? AND f.status = 'parsed'
      ORDER BY bm25Score, f.added_at, c.idx
      LIMIT ?
    `)
  }

  search(modeId: string, query: string, k: number): KnowledgeSnippet[] {
    const limit = Math.min(Math.floor(k), MAX_RESULTS)
    if (!(limit > 0)) return []
    const match = buildMatchQuery(query)
    if (!match) return []
    try {
      return this.stmt.all(match, modeId, limit).map((r) => ({
        fileId: r.fileId,
        filename: r.filename,
        chunkIdx: r.chunkIdx,
        text: r.text,
        // bm25() is negative with "more negative = better"; flip it so higher is better.
        score: -r.bm25Score,
      }))
    } catch (err) {
      // Retrieval only enriches a prompt; it must never break the live answer.
      this.log?.warn('Knowledge search failed', err)
      return []
    }
  }
}
