import { beforeEach, describe, expect, it, vi } from 'vitest'
import { openDatabase, type Db } from '@main/db/database'
import type { Logger } from '@main/log'
import {
  Fts5Retriever,
  MAX_QUERY_TERMS,
  buildMatchQuery,
  extractQueryTerms,
} from '@main/knowledge/retriever'

let db: Db
let retriever: Fts5Retriever

function seedMode(id: string): void {
  db.prepare('INSERT INTO modes(id, name, created_at, updated_at) VALUES (?, ?, 0, 0)').run(id, id)
}

function seedFile(
  id: string,
  modeId: string,
  filename: string,
  chunks: string[],
  status: 'parsed' | 'failed' | 'parsing' | 'pending' = 'parsed',
  addedAt = 0,
): void {
  db.prepare(
    'INSERT INTO knowledge_files(id, mode_id, filename, size, status, chunk_count, added_at) VALUES (?, ?, ?, 1, ?, ?, ?)',
  ).run(id, modeId, filename, status, chunks.length, addedAt)
  const ins = db.prepare('INSERT INTO knowledge_chunks(file_id, idx, text) VALUES (?, ?, ?)')
  chunks.forEach((text, idx) => ins.run(id, idx, text))
}

beforeEach(() => {
  db = openDatabase(':memory:')
  retriever = new Fts5Retriever(db)
  seedMode('sales')
  seedMode('interview')
  seedFile('f-pricing', 'sales', 'pricing.pdf', [
    'Our Starter plan is ten dollars per seat each month.',
    'The Enterprise plan costs forty dollars per seat and includes SSO, audit logs and priority support.',
    'Discounts: non-profits get 50% off any plan.',
  ])
  seedFile('f-security', 'sales', 'security.md', [
    'We are SOC 2 Type II certified. Data is encrypted at rest and in transit.',
    'Café résumé: the founders met at a café in Lisbon.',
  ])
  seedFile('f-failed', 'sales', 'broken.pdf', ['Enterprise enterprise enterprise seat'], 'failed')
  seedFile('f-parsing', 'sales', 'half.pdf', ['Enterprise seat pricing in progress'], 'parsing')
  seedFile('f-interview', 'interview', 'resume.docx', [
    'Enterprise sales experience: closed a forty dollar per seat enterprise deal.',
  ])
  seedFile('f-bangla', 'sales', 'bangla.txt', [
    'আমাদের এন্টারপ্রাইজ প্ল্যানের দাম প্রতি মাসে পাঁচ হাজার টাকা।',
    'আমরা ঢাকায় অবস্থিত।',
  ])
})

describe('extractQueryTerms / buildMatchQuery', () => {
  it('lower-cases, drops stopwords and punctuation, dedupes', () => {
    expect(
      extractQueryTerms('What does the Enterprise plan cost per seat? The ENTERPRISE one!'),
    ).toEqual(['enterprise', 'plan', 'cost', 'seat', 'one'])
    expect(buildMatchQuery('Enterprise plan')).toBe('"enterprise"* OR "plan"*')
  })

  it('drops FTS operators and syntax characters', () => {
    expect(
      extractQueryTerms('pricing AND NEAR(seat, 5) OR NOT "sso" col:val ^start -x +y'),
    ).toEqual(['pricing', 'seat', '5', 'sso', 'col', 'val', 'start'])
  })

  it('keeps Bangla words intact (combining marks included) and drops Bangla particles', () => {
    expect(extractQueryTerms('আপনাদের প্ল্যানের দাম কত? আর কি আছে?')).toEqual([
      'আপনাদের',
      'প্ল্যানের',
      'দাম',
    ])
  })

  it('caps the number of terms, keeping the most specific ones in original order', () => {
    const many = Array.from({ length: 30 }, (_, i) => `term${'x'.repeat(i % 7)}${i}`).join(' ')
    const terms = extractQueryTerms(many)
    expect(terms).toHaveLength(MAX_QUERY_TERMS)
    const positions = terms.map((t) => many.split(' ').indexOf(t))
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
    const minKept = Math.min(...terms.map((t) => t.length))
    const dropped = many.split(' ').filter((t) => !terms.includes(t))
    for (const t of dropped) expect(t.length).toBeLessThanOrEqual(minKept)
  })

  it('ignores implausibly long tokens', () => {
    expect(extractQueryTerms(`pricing ${'z'.repeat(65)} ${'y'.repeat(64)}`)).toEqual([
      'pricing',
      'y'.repeat(64),
    ])
  })

  it('returns null when nothing searchable is left', () => {
    expect(buildMatchQuery('')).toBeNull()
    expect(buildMatchQuery('   ')).toBeNull()
    expect(buildMatchQuery('what is the, and, or... a?')).toBeNull()
    expect(buildMatchQuery('"*:^()-')).toBeNull()
  })
})

describe('Fts5Retriever', () => {
  it('ranks the best-matching chunk first and returns filename, chunk index and score', () => {
    const hits = retriever.search('sales', 'How much is the enterprise plan per seat?', 5)
    expect(hits[0]).toMatchObject({
      fileId: 'f-pricing',
      filename: 'pricing.pdf',
      chunkIdx: 1,
    })
    expect(hits[0]?.text).toContain('forty dollars')
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score)
    }
    expect(hits.every((h) => h.score > 0)).toBe(true)
  })

  it('matches word prefixes (seat → seats) and folds diacritics (cafe → café)', () => {
    seedFile('f-extra', 'sales', 'extra.txt', ['We sell seats in bundles of ten.'])
    expect(retriever.search('sales', 'seat bundles', 3)[0]?.fileId).toBe('f-extra')
    expect(retriever.search('sales', 'cafe in lisbon', 3)[0]).toMatchObject({
      fileId: 'f-security',
      chunkIdx: 1,
    })
  })

  it('only searches the given Mode', () => {
    const sales = retriever.search('sales', 'enterprise deal experience', 10)
    expect(sales.some((h) => h.fileId === 'f-interview')).toBe(false)
    const interview = retriever.search('interview', 'enterprise deal experience', 10)
    expect(interview.map((h) => h.fileId)).toEqual(['f-interview'])
    expect(retriever.search('nope', 'enterprise', 10)).toEqual([])
  })

  it('ignores files that are not parsed', () => {
    const hits = retriever.search('sales', 'enterprise seat pricing progress', 20)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.some((h) => h.fileId === 'f-failed' || h.fileId === 'f-parsing')).toBe(false)
  })

  it('finds Bangla text', () => {
    const hits = retriever.search('sales', 'এন্টারপ্রাইজ প্ল্যানের দাম কত?', 3)
    expect(hits[0]).toMatchObject({ fileId: 'f-bangla', chunkIdx: 0 })
  })

  it('respects k', () => {
    expect(retriever.search('sales', 'plan seat enterprise sso data', 2)).toHaveLength(2)
    expect(retriever.search('sales', 'plan', 0)).toEqual([])
    expect(retriever.search('sales', 'plan', -3)).toEqual([])
    expect(retriever.search('sales', 'plan', Number.NaN)).toEqual([])
  })

  it('returns nothing for empty or stopword-only queries', () => {
    expect(retriever.search('sales', '', 5)).toEqual([])
    expect(retriever.search('sales', '  \n ', 5)).toEqual([])
    expect(retriever.search('sales', 'what is it?', 5)).toEqual([])
  })

  it('never throws on FTS5 syntax in the query', () => {
    const nasty = [
      '"',
      '""',
      '"unbalanced quote',
      '*',
      'plan*',
      '* OR *',
      'AND',
      'OR',
      'NOT',
      'NEAR(',
      'NEAR(plan seat, 2)',
      'plan AND',
      'AND plan',
      '-',
      '-plan',
      'plan - seat',
      ':',
      'text:plan',
      '{text}: plan',
      '^',
      '^plan',
      '(',
      ')',
      '(plan OR',
      'plan) seat (',
      '[plan]',
      "plan's \\ / ; ' ` ~ ! @ # $ % & = + | < > ?",
      '্',
      'a'.repeat(5000),
    ]
    for (const q of nasty) {
      expect(() => retriever.search('sales', q, 5), q).not.toThrow()
      expect(Array.isArray(retriever.search('sales', q, 5))).toBe(true)
    }
    // Meaningful words survive the sanitizing.
    expect(retriever.search('sales', '"enterprise* AND NEAR(sso', 1)[0]?.fileId).toBe('f-pricing')
  })

  it('logs and returns [] if the database fails instead of throwing', () => {
    const warn = vi.fn()
    const log = { warn } as unknown as Logger
    const r = new Fts5Retriever(db, log)
    db.exec('DROP TABLE knowledge_chunks_fts')
    expect(r.search('sales', 'enterprise', 3)).toEqual([])
    expect(warn).toHaveBeenCalledOnce()
  })
})
