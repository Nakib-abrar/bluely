import { readFile, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, extname, join } from 'node:path'
import { KNOWLEDGE_LIMITS } from '@shared/constants'
import type * as PdfJsModule from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { TextItem, TextMarkedContent } from 'pdfjs-dist/types/src/display/api'
import { KnowledgeError, knowledgeMessages, reasons } from './messages'

export { KnowledgeError } from './messages'

export type KnowledgeExtension = (typeof KNOWLEDGE_LIMITS.extensions)[number]

export interface ExtractedText {
  /** Normalized plain text: LF line endings, no trailing spaces, at most one blank line in a row. */
  text: string
  /** Page count for PDFs; null for other formats. */
  pages: number | null
}

const MAX_DETAIL_LENGTH = 120

/** The supported extension of `filePath` (lower-cased), or null. */
export function knowledgeExtension(filePath: string): KnowledgeExtension | null {
  const ext = extname(filePath).toLowerCase()
  return (KNOWLEDGE_LIMITS.extensions as readonly string[]).includes(ext)
    ? (ext as KnowledgeExtension)
    : null
}

/**
 * Extracts plain text from a PDF, DOCX, TXT or MD file (chosen by extension, case-insensitive).
 * Throws `KnowledgeError` with a friendly `reason` for every expected failure.
 */
export async function extractText(filePath: string): Promise<ExtractedText> {
  const ext = knowledgeExtension(filePath)
  if (!ext) throw new KnowledgeError(reasons.unsupportedType)

  let size: number
  try {
    const info = await stat(filePath)
    if (!info.isFile()) {
      throw new KnowledgeError(reasons.unreadable(knowledgeMessages.details.notAFile))
    }
    size = info.size
  } catch (err) {
    throw toKnowledgeError(err)
  }
  if (size > KNOWLEDGE_LIMITS.maxFileBytes) throw new KnowledgeError(reasons.tooLarge)
  if (size === 0) throw new KnowledgeError(reasons.empty)

  let data: Buffer
  try {
    data = await readFile(filePath)
  } catch (err) {
    throw toKnowledgeError(err)
  }
  // The file may have changed since stat().
  if (data.byteLength > KNOWLEDGE_LIMITS.maxFileBytes) throw new KnowledgeError(reasons.tooLarge)
  if (data.byteLength === 0) throw new KnowledgeError(reasons.empty)

  switch (ext) {
    case '.txt':
    case '.md':
      return withText(normalizeText(decodeTextBuffer(data)), null, reasons.empty)
    case '.docx':
      return withText(normalizeText(await extractDocx(data)), null, reasons.empty)
    case '.pdf': {
      const pdf = await extractPdf(data)
      return withText(normalizeText(pdf.text), pdf.pages, reasons.pdfNoText)
    }
  }
}

function withText(text: string, pages: number | null, emptyReason: string): ExtractedText {
  if (!text) throw new KnowledgeError(emptyReason)
  return { text, pages }
}

// ───────────────────────────── plain text ─────────────────────────────

const utf8 = new TextDecoder('utf-8', { fatal: true })

/**
 * Decodes a text file: UTF-8 (BOM stripped), UTF-16 LE/BE when a BOM says so, otherwise
 * Windows-1252 ("latin1") when the bytes are not valid UTF-8 (typical of older Windows files).
 */
export function decodeTextBuffer(data: Uint8Array): string {
  if (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(data.subarray(3))
  }
  if (data[0] === 0xff && data[1] === 0xfe) return decodeUtf16(data.subarray(2), 'le')
  if (data[0] === 0xfe && data[1] === 0xff) return decodeUtf16(data.subarray(2), 'be')
  try {
    return utf8.decode(data)
  } catch {
    return decodeLatin1(data)
  }
}

function decodeUtf16(data: Uint8Array, order: 'le' | 'be'): string {
  // Drop a dangling odd byte rather than failing the whole file.
  const even = data.subarray(0, data.byteLength - (data.byteLength % 2))
  if (order === 'le') return new TextDecoder('utf-16le').decode(even)
  const swapped = Buffer.from(even)
  swapped.swap16()
  return new TextDecoder('utf-16le').decode(swapped)
}

function decodeLatin1(data: Uint8Array): string {
  try {
    // WHATWG "latin1" is windows-1252, which maps 0x80–0x9F to curly quotes, dashes, €, …
    return new TextDecoder('windows-1252').decode(data)
  } catch {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('latin1')
  }
}

/**
 * Normalizes extracted text: NFC, CRLF/CR → LF, control characters dropped, trailing spaces
 * trimmed, runs of blank lines collapsed to one (paragraph breaks are kept), outer whitespace
 * trimmed.
 */
export function normalizeText(text: string): string {
  return (
    text
      .normalize('NFC')
      .replace(/\r\n?/g, '\n')
      .replace(/[\f\v\u0085\u2028\u2029]/g, '\n')
      // eslint-disable-next-line no-control-regex -- stripping control characters is the point
      .replace(/[\u0000-\u0008\u000e-\u001f\u007f\ufeff]/g, '')
      .replace(/[^\S\n]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  )
}

// ───────────────────────────── DOCX ─────────────────────────────

async function extractDocx(data: Buffer): Promise<string> {
  try {
    const { default: mammoth } = await import('mammoth')
    const result = await mammoth.extractRawText({ buffer: data })
    return result.value
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const invalid =
      /zip|central directory|end of data|main document|corrupt|signature|not a valid/i.test(message)
    throw new KnowledgeError(
      reasons.unreadable(invalid ? knowledgeMessages.details.invalidDocx : shortDetail(message)),
      { cause: err },
    )
  }
}

// ───────────────────────────── PDF ─────────────────────────────

type PdfJs = typeof PdfJsModule

let pdfjsLoader: Promise<PdfJs> | null = null

/**
 * Loads pdf.js lazily (it is large and ESM-only).
 *
 * WHY the worker import: Node has no Web Workers, so pdf.js always runs its worker code on the
 * calling thread ("fake worker"). Importing the worker module first registers
 * `globalThis.pdfjsWorker`, so pdf.js never has to resolve a `workerSrc` path, which keeps this
 * working unchanged in Vitest, in the electron-vite bundle (deps stay external) and if pdf.js is
 * ever bundled. Bare specifiers resolve from node_modules at runtime, not relative to __dirname.
 */
function loadPdfjs(): Promise<PdfJs> {
  if (!pdfjsLoader) {
    pdfjsLoader = (async () => {
      await import('pdfjs-dist/legacy/build/pdf.worker.mjs')
      return import('pdfjs-dist/legacy/build/pdf.mjs')
    })().catch((err: unknown) => {
      pdfjsLoader = null
      throw err
    })
  }
  return pdfjsLoader
}

let assetDirs: { cMapUrl?: string; standardFontDataUrl?: string } | null = null

/**
 * Directories with pdf.js character maps (needed to map CJK fonts to Unicode) and standard font
 * data. Optional: text extraction still works for most PDFs without them.
 */
function pdfjsAssetDirs(): { cMapUrl?: string; standardFontDataUrl?: string } {
  if (assetDirs) return assetDirs
  try {
    const root = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
    // pdf.js insists on a trailing "/"; forward slashes are fine for fs on Windows too.
    const dir = (name: string) => `${join(root, name).replace(/\\/g, '/')}/`
    assetDirs = { cMapUrl: dir('cmaps'), standardFontDataUrl: dir('standard_fonts') }
  } catch {
    assetDirs = {}
  }
  return assetDirs
}

async function extractPdf(data: Buffer): Promise<{ text: string; pages: number }> {
  let pdfjs: PdfJs
  try {
    pdfjs = await loadPdfjs()
  } catch (err) {
    throw new KnowledgeError(reasons.unreadable(shortDetail(err)), { cause: err })
  }
  const task = pdfjs.getDocument({
    // pdf.js transfers (detaches) the buffer it is given, and rejects Node Buffers: pass a copy.
    data: new Uint8Array(data),
    // No DOM in Node. (pdf.js 6 no longer has `isEvalSupported`: it never uses eval.)
    useSystemFonts: false,
    disableFontFace: true,
    isOffscreenCanvasSupported: false,
    enableXfa: false,
    verbosity: pdfjs.VerbosityLevel.ERRORS,
    cMapPacked: true,
    ...pdfjsAssetDirs(),
  })
  try {
    const doc = await task.promise
    const pages: string[] = []
    let firstPageError: unknown = null
    for (let n = 1; n <= doc.numPages; n++) {
      // One damaged page should not cost the user the rest of the document.
      try {
        const page = await doc.getPage(n)
        try {
          const content = await page.getTextContent()
          pages.push(textItemsToString(content.items))
        } finally {
          page.cleanup()
        }
      } catch (err) {
        firstPageError ??= err
      }
    }
    if (firstPageError && !pages.some((p) => p.trim())) throw firstPageError
    return { text: pages.join('\n\n'), pages: doc.numPages }
  } catch (err) {
    throw pdfError(err)
  } finally {
    await task.destroy().catch(() => undefined)
  }
}

function pdfError(err: unknown): KnowledgeError {
  if (err instanceof KnowledgeError) return err
  const name = err instanceof Error ? err.name : ''
  if (name === 'PasswordException') return new KnowledgeError(reasons.pdfPassword, { cause: err })
  if (name === 'InvalidPDFException' || name === 'FormatError') {
    return new KnowledgeError(reasons.unreadable(knowledgeMessages.details.invalidPdf), {
      cause: err,
    })
  }
  return new KnowledgeError(reasons.unreadable(shortDetail(err)), { cause: err })
}

/** A new line starts when the baseline moves by more than this fraction of the text height. */
const NEW_LINE_RATIO = 0.5
/** A blank line (paragraph break) is inserted when the baseline jumps by more than this. */
const PARAGRAPH_GAP_RATIO = 1.7
/** A space is inserted between same-line items separated by more than this fraction. */
const WORD_GAP_RATIO = 0.15

/**
 * Joins pdf.js text items into lines. pdf.js marks line ends with `hasEOL`, but not reliably
 * for every producer, so baseline (y) jumps also start a line, large jumps a paragraph, and
 * horizontal gaps between items on the same line become spaces.
 */
export function textItemsToString(items: readonly (TextItem | TextMarkedContent)[]): string {
  let out = ''
  let prev: { right: number; y: number; size: number } | null = null
  let pendingEol = false
  for (const item of items) {
    if (!('str' in item)) continue
    const x = Number(item.transform[4]) || 0
    const y = Number(item.transform[5]) || 0
    const size =
      item.height > 0
        ? item.height
        : Math.hypot(Number(item.transform[2]) || 0, Number(item.transform[3]) || 0) || 10
    if (!item.str) {
      if (item.hasEOL) pendingEol = true
      continue
    }
    if (prev) {
      const dy = Math.abs(prev.y - y)
      const lineHeight = Math.max(prev.size, size)
      if (pendingEol || dy > lineHeight * NEW_LINE_RATIO) {
        out = out.replace(/[^\S\n]+$/, '')
        out += dy > lineHeight * PARAGRAPH_GAP_RATIO ? '\n\n' : '\n'
      } else if (
        x - prev.right > size * WORD_GAP_RATIO &&
        !/\s$/.test(out) &&
        !/^\s/.test(item.str)
      ) {
        out += ' '
      }
    }
    out += item.str
    prev = { right: x + item.width, y, size }
    pendingEol = item.hasEOL
  }
  return out
}

// ───────────────────────────── errors ─────────────────────────────

/** Maps any error thrown while reading a file to a KnowledgeError with a friendly reason. */
export function toKnowledgeError(err: unknown): KnowledgeError {
  if (err instanceof KnowledgeError) return err
  const code = (err as NodeJS.ErrnoException | null)?.code
  const d = knowledgeMessages.details
  const detail =
    code === 'ENOENT' || code === 'ENOTDIR'
      ? d.notFound
      : code === 'EACCES' || code === 'EPERM'
        ? d.permission
        : code === 'EBUSY'
          ? d.busy
          : code === 'EISDIR'
            ? d.notAFile
            : shortDetail(err)
  return new KnowledgeError(reasons.unreadable(detail), { cause: err })
}

/** First line of an error message, without file paths, capped for display. */
function shortDetail(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  const line = (raw.split('\n')[0] ?? '')
    // Paths can be long and leak folder names into the UI; the row already shows the filename.
    .replace(/'[^']*[\\/][^']*'/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!line) return knowledgeMessages.details.unknown
  return line.length > MAX_DETAIL_LENGTH ? `${line.slice(0, MAX_DETAIL_LENGTH - 1)}…` : line
}
