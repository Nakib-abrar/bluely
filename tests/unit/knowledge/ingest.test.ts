import { truncateSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KNOWLEDGE_LIMITS } from '@shared/constants'
import type { KnowledgeFile } from '@shared/types'
import { openDatabase, type Db } from '@main/db/database'
import { AppError } from '@main/errors'
import type { Logger } from '@main/log'
import { KnowledgeService, type KnowledgeServiceDeps } from '@main/knowledge/ingest'
import { KnowledgeError } from '@main/knowledge/parsers'
import { Fts5Retriever } from '@main/knowledge/retriever'
import { docx, englishText, tempDir, textPdf, type TempDir } from './fixtures'

interface ChangedEvent {
  modeId: string
  files: KnowledgeFile[]
}

const silentLog: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLog,
  setDebug: () => undefined,
}

let db: Db
let tmp: TempDir
let events: ChangedEvent[]
let clock: number

function makeService(overrides: Partial<KnowledgeServiceDeps> = {}): KnowledgeService {
  return new KnowledgeService({
    db,
    log: silentLog,
    now: () => ++clock,
    events: {
      broadcast: (event, payload) => {
        expect(event).toBe('knowledge:changed')
        events.push(structuredClone(payload as ChangedEvent))
      },
    },
    ...overrides,
  })
}

/** Status snapshot of every event: one string per event, e.g. "a.txt:pending b.txt:failed". */
function timeline(): string[] {
  return events.map((e) => e.files.map((f) => `${f.filename}:${f.status}`).join(' '))
}

function count(sql: string, ...params: unknown[]): number {
  return (db.prepare(sql).get(...params) as { c: number }).c
}

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  db = openDatabase(':memory:')
  db.prepare(
    "INSERT INTO modes(id, name, created_at, updated_at) VALUES ('m1', 'Sales', 0, 0)",
  ).run()
  db.prepare(
    "INSERT INTO modes(id, name, created_at, updated_at) VALUES ('m2', 'Other', 0, 0)",
  ).run()
  tmp = tempDir()
  events = []
  clock = 1_000
})

afterEach(() => tmp.cleanup())

describe('KnowledgeService.addFiles', () => {
  it('parses a file and walks pending → parsing → parsed, emitting after each change', async () => {
    const svc = makeService()
    const path = tmp.write('pricing.txt', 'The enterprise plan costs forty dollars per seat.')
    const [file] = await svc.addFiles('m1', [path])
    expect(file).toMatchObject({
      modeId: 'm1',
      filename: 'pricing.txt',
      size: 49,
      status: 'parsed',
      error: null,
      chunkCount: 1,
    })
    expect(timeline()).toEqual(['pricing.txt:pending', 'pricing.txt:parsing', 'pricing.txt:parsed'])
    expect(events.every((e) => e.modeId === 'm1')).toBe(true)
    expect(svc.list('m1')).toEqual([file])
    // Only the extracted text is stored.
    expect(db.prepare('SELECT idx, text FROM knowledge_chunks').all()).toEqual([
      { idx: 0, text: 'The enterprise plan costs forty dollars per seat.' },
    ])
  })

  it('keeps going after bad files and reports each with a friendly reason', async () => {
    const svc = makeService()
    const good = tmp.write('a-good.md', '# Onboarding\n\nTakes two weeks.')
    const unsupported = tmp.write('b-slides.pptx', 'zip')
    const broken = tmp.write('c-broken.pdf', 'not really a pdf')
    const empty = tmp.write('d-empty.txt', '')
    const docFile = tmp.write('e-brief.docx', docx(['Support is 24/7.']))
    const pdf = tmp.write('f-deck.pdf', textPdf([[['Series A: raising two million.']]]))
    const files = await svc.addFiles('m1', [good, unsupported, broken, empty, docFile, pdf])

    expect(files.map((f) => [f.filename, f.status, f.error, f.chunkCount])).toEqual([
      ['a-good.md', 'parsed', null, 1],
      ['b-slides.pptx', 'failed', 'Unsupported file type', 0],
      ['c-broken.pdf', 'failed', "Couldn't read this file: not a valid PDF", 0],
      ['d-empty.txt', 'failed', 'The file is empty', 0],
      ['e-brief.docx', 'parsed', null, 1],
      ['f-deck.pdf', 'parsed', null, 1],
    ])
    // Rejected-up-front files are failed in the very first event; the rest are processed in order.
    expect(timeline()).toEqual([
      'a-good.md:pending b-slides.pptx:failed c-broken.pdf:pending d-empty.txt:failed e-brief.docx:pending f-deck.pdf:pending',
      'a-good.md:parsing b-slides.pptx:failed c-broken.pdf:pending d-empty.txt:failed e-brief.docx:pending f-deck.pdf:pending',
      'a-good.md:parsed b-slides.pptx:failed c-broken.pdf:pending d-empty.txt:failed e-brief.docx:pending f-deck.pdf:pending',
      'a-good.md:parsed b-slides.pptx:failed c-broken.pdf:parsing d-empty.txt:failed e-brief.docx:pending f-deck.pdf:pending',
      'a-good.md:parsed b-slides.pptx:failed c-broken.pdf:failed d-empty.txt:failed e-brief.docx:pending f-deck.pdf:pending',
      'a-good.md:parsed b-slides.pptx:failed c-broken.pdf:failed d-empty.txt:failed e-brief.docx:parsing f-deck.pdf:pending',
      'a-good.md:parsed b-slides.pptx:failed c-broken.pdf:failed d-empty.txt:failed e-brief.docx:parsed f-deck.pdf:pending',
      'a-good.md:parsed b-slides.pptx:failed c-broken.pdf:failed d-empty.txt:failed e-brief.docx:parsed f-deck.pdf:parsing',
      'a-good.md:parsed b-slides.pptx:failed c-broken.pdf:failed d-empty.txt:failed e-brief.docx:parsed f-deck.pdf:parsed',
    ])
    const retriever = new Fts5Retriever(db)
    expect(retriever.search('m1', 'series raising', 3)[0]?.filename).toBe('f-deck.pdf')
  })

  it('stores many chunks for a long file in one go', async () => {
    const svc = makeService()
    const [file] = await svc.addFiles('m1', [tmp.write('long.txt', englishText(400))])
    expect(file?.status).toBe('parsed')
    expect(file?.chunkCount).toBeGreaterThan(3)
    expect(count('SELECT count(*) c FROM knowledge_chunks WHERE file_id = ?', file?.id)).toBe(
      file?.chunkCount,
    )
    const idx = db
      .prepare('SELECT idx FROM knowledge_chunks WHERE file_id = ? ORDER BY idx')
      .all(file?.id)
      .map((r) => (r as { idx: number }).idx)
    expect(idx).toEqual(Array.from({ length: file?.chunkCount ?? 0 }, (_, i) => i))
  })

  it('rejects files over 20 MB (sparse file) and records their size', async () => {
    const svc = makeService()
    const path = tmp.write('huge.pdf', '')
    truncateSync(path, KNOWLEDGE_LIMITS.maxFileBytes + 1)
    const [file] = await svc.addFiles('m1', [path])
    expect(file).toMatchObject({
      status: 'failed',
      error: 'File is larger than 20 MB',
      size: KNOWLEDGE_LIMITS.maxFileBytes + 1,
    })
    expect(timeline()).toEqual(['huge.pdf:failed'])
  })

  it('reports missing files, folders and relative paths', async () => {
    const svc = makeService()
    const files = await svc.addFiles('m1', [
      tmp.path('gone.txt'),
      'relative/notes.txt',
      tmp.write('dir.md/inner.txt', 'x').replace(/[\\/]inner\.txt$/, ''),
    ])
    expect(files.map((f) => f.error)).toEqual([
      "Couldn't read this file: file not found",
      "Couldn't read this file: invalid path",
      "Couldn't read this file: not a regular file",
    ])
  })

  it('enforces 50 files per Mode, counting existing files but not failed ones', async () => {
    const svc = makeService()
    const paths = Array.from({ length: 52 }, (_, i) =>
      tmp.write(`doc-${String(i).padStart(2, '0')}.txt`, `Document ${i} talks about topic${i}.`),
    )
    const first = await svc.addFiles('m1', paths.slice(0, 30))
    expect(first.every((f) => f.status === 'parsed')).toBe(true)

    const bad = await svc.addFiles('m1', [tmp.write('bad.txt', '')])
    expect(bad[0]?.status).toBe('failed')

    const second = await svc.addFiles('m1', paths.slice(30))
    expect(second.slice(0, 20).every((f) => f.status === 'parsed')).toBe(true)
    expect(second.slice(20).map((f) => [f.filename, f.status, f.error])).toEqual([
      ['doc-50.txt', 'failed', 'This Mode already has 50 files'],
      ['doc-51.txt', 'failed', 'This Mode already has 50 files'],
    ])
    expect(svc.list('m1').filter((f) => f.status === 'parsed')).toHaveLength(50)

    // Other Modes have their own limit.
    expect((await svc.addFiles('m2', [paths[0] as string]))[0]?.status).toBe('parsed')

    // Freeing a slot lets the next file in; re-adding a full Mode's file replaces in place.
    svc.delete(first[0]?.id as string)
    const retry = await svc.addFiles('m1', [paths[51] as string])
    expect(retry[0]).toMatchObject({ filename: 'doc-51.txt', status: 'parsed' })
    const replace = await svc.addFiles('m1', [paths[1] as string])
    expect(replace[0]).toMatchObject({ filename: 'doc-01.txt', status: 'parsed' })
  })

  it('replaces a file with the same name (case-insensitive) in the same Mode', async () => {
    const svc = makeService()
    const retriever = new Fts5Retriever(db)
    const v1 = tmp.write('v1/Pricing.txt', 'Old price: thirty dollars per seat.')
    const [old] = await svc.addFiles('m1', [v1])
    await svc.addFiles('m2', [v1])
    const v2 = tmp.write('v2/pricing.TXT', 'New price: forty dollars per seat.')
    const [fresh] = await svc.addFiles('m1', [v2])

    expect(fresh?.id).not.toBe(old?.id)
    expect(svc.list('m1').map((f) => f.filename)).toEqual(['pricing.TXT'])
    expect(retriever.search('m1', 'thirty', 5)).toEqual([])
    expect(retriever.search('m1', 'forty', 5)[0]?.fileId).toBe(fresh?.id)
    // The other Mode keeps its own copy.
    expect(retriever.search('m2', 'thirty', 5)).toHaveLength(1)
    // The replaced row disappears in the very first event of the new batch.
    expect(timeline().at(-3)).toBe('pricing.TXT:pending')
  })

  it('keeps only the last of duplicate names within one batch', async () => {
    const svc = makeService()
    const a = tmp.write('a/notes.md', 'first version')
    const b = tmp.write('b/notes.md', 'second version')
    const files = await svc.addFiles('m1', [a, b])
    expect(files).toHaveLength(1)
    expect(db.prepare('SELECT text FROM knowledge_chunks').all()).toEqual([
      { text: 'second version' },
    ])
  })

  it('throws not_found for an unknown Mode', async () => {
    const svc = makeService()
    await expect(svc.addFiles('nope', [tmp.write('x.txt', 'x')])).rejects.toMatchObject({
      code: 'not_found',
    })
    await expect(svc.addFiles('nope', [])).rejects.toBeInstanceOf(AppError)
    expect(await svc.addFiles('m1', [])).toEqual([])
    expect(events).toEqual([])
  })

  it('turns unexpected parser/chunker errors into a failed row', async () => {
    const svc = makeService({
      chunk: () => {
        throw new Error('boom: chunker exploded')
      },
    })
    const [file] = await svc.addFiles('m1', [tmp.write('x.txt', 'hello')])
    expect(file).toMatchObject({
      status: 'failed',
      error: "Couldn't read this file: boom: chunker exploded",
    })
  })

  it('processes files one at a time, even across concurrent calls', async () => {
    let running = 0
    let maxRunning = 0
    const svc = makeService({
      extract: async (path) => {
        running++
        maxRunning = Math.max(maxRunning, running)
        await new Promise((r) => setTimeout(r, 5))
        running--
        return { text: `text of ${path}`, pages: null }
      },
    })
    const paths = ['a', 'b', 'c', 'd'].map((n) => tmp.write(`${n}.txt`, n))
    const [r1, r2] = await Promise.all([
      svc.addFiles('m1', paths.slice(0, 2)),
      svc.addFiles('m2', paths.slice(2)),
    ])
    expect(maxRunning).toBe(1)
    expect([...(r1 ?? []), ...(r2 ?? [])].every((f) => f.status === 'parsed')).toBe(true)
  })

  it('drops the result of a file deleted while it was being parsed', async () => {
    const gate = deferred<{ text: string; pages: number | null }>()
    const started = deferred<void>()
    const svc = makeService({
      extract: () => {
        started.resolve()
        return gate.promise
      },
    })
    const pending = svc.addFiles('m1', [tmp.write('slow.txt', 'slow')])
    await started.promise
    const [row] = svc.list('m1')
    expect(row?.status).toBe('parsing')
    svc.delete(row?.id as string)
    gate.resolve({ text: 'late text', pages: null })
    expect(await pending).toEqual([])
    expect(count('SELECT count(*) c FROM knowledge_chunks')).toBe(0)
    expect(svc.list('m1')).toEqual([])
  })

  it('maps KnowledgeError reasons from the parser verbatim', async () => {
    const svc = makeService({
      extract: () => Promise.reject(new KnowledgeError('This PDF is password-protected')),
    })
    const [file] = await svc.addFiles('m1', [tmp.write('locked.pdf', '%PDF')])
    expect(file?.error).toBe('This PDF is password-protected')
  })
})

describe('KnowledgeService deletion and recovery', () => {
  it('delete removes the row, its chunks and their FTS entries', async () => {
    const svc = makeService()
    const [a] = await svc.addFiles('m1', [tmp.write('a.txt', englishText(200))])
    const [b] = await svc.addFiles('m1', [tmp.write('b.txt', 'Keep this audit trail.')])
    const fts = (term: string) =>
      count('SELECT count(*) c FROM knowledge_chunks_fts WHERE knowledge_chunks_fts MATCH ?', term)
    expect(fts('onboarding')).toBeGreaterThan(0)
    events = []

    svc.delete(a?.id as string)
    expect(svc.list('m1').map((f) => f.id)).toEqual([b?.id])
    expect(count('SELECT count(*) c FROM knowledge_chunks WHERE file_id = ?', a?.id)).toBe(0)
    expect(fts('onboarding')).toBe(0)
    expect(fts('audit')).toBe(1)
    expect(timeline()).toEqual(['b.txt:parsed'])

    svc.delete('does-not-exist')
    expect(events).toHaveLength(1)
  })

  it('deleteForMode clears one Mode only', async () => {
    const svc = makeService()
    await svc.addFiles('m1', [tmp.write('a.txt', 'alpha')])
    await svc.addFiles('m2', [tmp.write('b.txt', 'beta')])
    events = []
    svc.deleteForMode('m1')
    expect(svc.list('m1')).toEqual([])
    expect(svc.list('m2')).toHaveLength(1)
    expect(count('SELECT count(*) c FROM knowledge_chunks')).toBe(1)
    expect(events).toEqual([{ modeId: 'm1', files: [] }])
    svc.deleteForMode('m1')
    expect(events).toHaveLength(1)
  })

  it('recoverInterrupted fails rows left pending/parsing by a previous run', () => {
    const insert = db.prepare(
      "INSERT INTO knowledge_files(id, mode_id, filename, size, status, added_at) VALUES (?, 'm1', ?, 1, ?, 0)",
    )
    insert.run('p1', 'a.txt', 'pending')
    insert.run('p2', 'b.txt', 'parsing')
    insert.run('p3', 'c.txt', 'parsed')
    const warn = vi.fn()
    const svc = makeService({ log: { ...silentLog, warn } })
    expect(svc.recoverInterrupted()).toBe(2)
    expect(svc.list('m1').map((f) => [f.filename, f.status, f.error])).toEqual([
      ['a.txt', 'failed', 'Processing was interrupted. Remove the file and add it again.'],
      ['b.txt', 'failed', 'Processing was interrupted. Remove the file and add it again.'],
      ['c.txt', 'parsed', null],
    ])
    expect(events).toHaveLength(1)
    expect(warn).toHaveBeenCalledOnce()
    expect(svc.recoverInterrupted()).toBe(0)
  })

  it('idle() resolves once queued work is done', async () => {
    const gate = deferred<{ text: string; pages: number | null }>()
    const started = deferred<void>()
    const svc = makeService({
      extract: () => {
        started.resolve()
        return gate.promise
      },
    })
    const done = svc.addFiles('m1', [tmp.write('a.txt', 'alpha')])
    await started.promise
    let idle = false
    void svc.idle().then(() => {
      idle = true
    })
    await new Promise((r) => setTimeout(r, 10))
    expect(idle).toBe(false)
    gate.resolve({ text: 'alpha', pages: null })
    await done
    await svc.idle()
    expect(idle).toBe(true)
    expect(svc.list('m1')[0]?.status).toBe('parsed')
  })
})
