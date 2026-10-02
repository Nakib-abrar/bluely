/**
 * Programmatic fixtures for the knowledge tests: hand-built PDFs (with correct xref byte
 * offsets), a minimal DOCX zipped with fflate, and text files in several encodings.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'

// ───────────────────────────── PDF ─────────────────────────────

/** Escapes a string for a PDF literal string `( … )`. */
function pdfString(text: string): string {
  return text.replace(/[\\()]/g, (c) => `\\${c}`)
}

function pdfStream(data: string, dict = ''): string {
  return `<< /Length ${Buffer.byteLength(data, 'latin1')}${dict ? ` ${dict}` : ''} >>\nstream\n${data}\nendstream`
}

/**
 * Serializes objects (object n = objects[n - 1]; object 1 must be the catalog) into a PDF with
 * an exact cross-reference table. Everything is latin1 so string length = byte length.
 */
function serializePdf(objects: string[], trailerExtra = ''): Buffer {
  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'))
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = Buffer.byteLength(out, 'latin1')
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${trailerExtra} >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

interface PdfPage {
  content: string
  resources: string
}

function pagesPdf(pages: PdfPage[], extraObjects: string[] = [], trailerExtra = ''): Buffer {
  // 1 catalog, 2 pages, then (page, content) pairs, then the shared font, then extras.
  const objects: string[] = []
  const pageIds = pages.map((_, i) => 3 + i * 2)
  objects.push('<< /Type /Catalog /Pages 2 0 R >>')
  objects.push(
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`,
  )
  pages.forEach((page, i) => {
    const pageId = pageIds[i] as number
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources ${page.resources} /Contents ${pageId + 1} 0 R >>`,
    )
    objects.push(pdfStream(page.content))
  })
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
  objects.push(...extraObjects)
  return serializePdf(objects, trailerExtra)
}

/** Object number of the Helvetica font in `pagesPdf` output. */
function fontId(pageCount: number): number {
  return 3 + pageCount * 2
}

/**
 * A text PDF. Each page is a list of paragraphs; each paragraph a list of lines. Lines are 16pt
 * apart, paragraphs 40pt apart (so a blank line is expected between them). A line given as an
 * array is drawn as separate text runs on the same baseline with a gap between them.
 * Text is latin1 (WinAnsiEncoding), so "é" etc. are allowed.
 */
export function textPdf(pages: (string | string[])[][][]): Buffer {
  const font = fontId(pages.length)
  return pagesPdf(
    pages.map((paragraphs) => {
      const ops: string[] = ['BT', '/F1 12 Tf', '72 720 Td']
      paragraphs.forEach((lines, p) => {
        if (p > 0) ops.push('0 -40 Td')
        lines.forEach((line, l) => {
          if (l > 0) ops.push('0 -16 Td')
          if (typeof line === 'string') {
            ops.push(`(${pdfString(line)}) Tj`)
          } else {
            // Separate runs with a visible gap: [(a) -2000 (b)] TJ moves 24pt right.
            ops.push(`[${line.map((run) => `(${pdfString(run)})`).join(' -2000 ')}] TJ`)
          }
        })
      })
      ops.push('ET')
      return { content: ops.join('\n'), resources: `<< /Font << /F1 ${font} 0 R >> >>` }
    }),
  )
}

/** A one-page PDF that only paints an image (like a scan): no extractable text. */
export function imageOnlyPdf(): Buffer {
  const imageId = fontId(1) + 1
  const pixels = '\x00\xff\xff\x00'
  return pagesPdf(
    [
      {
        content: 'q 200 0 0 200 72 500 cm /Im1 Do Q',
        resources: `<< /XObject << /Im1 ${imageId} 0 R >> >>`,
      },
    ],
    [
      pdfStream(
        pixels,
        '/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8',
      ),
    ],
  )
}

/**
 * A PDF with a Standard security handler whose user password is not empty. The O/U entries
 * are arbitrary, so the empty password never validates and pdf.js asks for a password.
 */
export function encryptedPdf(): Buffer {
  const encryptId = fontId(1) + 1
  return pagesPdf(
    [
      {
        content: 'BT /F1 12 Tf 72 720 Td (Secret pricing) Tj ET',
        resources: `<< /Font << /F1 ${fontId(1)} 0 R >> >>`,
      },
    ],
    [`<< /Filter /Standard /V 1 /R 2 /O <${'ab'.repeat(32)}> /U <${'cd'.repeat(32)}> /P -44 >>`],
    ` /Encrypt ${encryptId} 0 R /ID [<0123456789abcdef0123456789abcdef> <0123456789abcdef0123456789abcdef>]`,
  )
}

/**
 * A PDF whose text uses a non-embedded Japanese CID font with the predefined `UniJIS-UCS2-H`
 * CMap. pdf.js can only map those codes to Unicode by loading its bundled character maps
 * (`cMapUrl`), so this proves the cmaps directory is found.
 */
export function cjkPdf(text: string): Buffer {
  const font = fontId(1)
  const hex = [...text]
    .map((c) => (c.codePointAt(0) ?? 0).toString(16).padStart(4, '0'))
    .join('')
    .toUpperCase()
  return pagesPdf(
    [
      {
        content: `BT /F2 12 Tf 72 720 Td <${hex}> Tj ET`,
        resources: `<< /Font << /F2 ${font + 1} 0 R >> >>`,
      },
    ],
    [
      `<< /Type /Font /Subtype /Type0 /BaseFont /KozMinPro-Regular /Encoding /UniJIS-UCS2-H /DescendantFonts [${font + 2} 0 R] >>`,
      `<< /Type /Font /Subtype /CIDFontType0 /BaseFont /KozMinPro-Regular /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 2 >> /FontDescriptor ${font + 3} 0 R /DW 1000 >>`,
      '<< /Type /FontDescriptor /FontName /KozMinPro-Regular /Flags 6 /FontBBox [0 -120 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 740 /StemV 80 >>',
    ],
  )
}

// ───────────────────────────── DOCX ─────────────────────────────

function xmlEscape(text: string): string {
  return text.replace(/[<>&"]/g, (c) =>
    c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : '&quot;',
  )
}

/** A minimal valid .docx with one `w:p` per paragraph. */
export function docx(paragraphs: string[], opts: { omitDocument?: boolean } = {}): Buffer {
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '</Types>',
    ),
    '_rels/.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        '</Relationships>',
    ),
  }
  if (!opts.omitDocument) {
    files['word/document.xml'] = strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
        paragraphs
          .map((p) => `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(p)}</w:t></w:r></w:p>`)
          .join('') +
        '</w:body></w:document>',
    )
  }
  return Buffer.from(zipSync(files))
}

// ───────────────────────────── text ─────────────────────────────

export function utf8(text: string, bom = false): Buffer {
  const body = Buffer.from(text, 'utf8')
  return bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body
}

export function utf16le(text: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
}

export function utf16be(text: string): Buffer {
  const le = Buffer.from(text, 'utf16le')
  le.swap16()
  return Buffer.concat([Buffer.from([0xfe, 0xff]), le])
}

export const BANGLA_TEXT =
  'আমাদের কোম্পানি ঢাকায় অবস্থিত। আমরা ছোট ব্যবসার জন্য সফটওয়্যার তৈরি করি। ' +
  'এন্টারপ্রাইজ প্ল্যানের দাম প্রতি মাসে পাঁচ হাজার টাকা। আপনি কি ডেমো দেখতে চান?'

/** A long, varied English text: `count` distinct sentences grouped into paragraphs of 6. */
export function englishText(count: number): string {
  const subjects = ['The team', 'Our customer', 'The product', 'Each region', 'The pilot']
  const verbs = ['reviewed', 'improved', 'measured', 'documented', 'shipped']
  const objects = ['the onboarding flow', 'quarterly revenue', 'support latency', 'seat pricing']
  const sentences: string[] = []
  for (let i = 0; i < count; i++) {
    const s = subjects[i % subjects.length]
    const v = verbs[(i * 3) % verbs.length]
    const o = objects[(i * 7) % objects.length]
    sentences.push(`${s} ${v} ${o} in iteration number${i} before the deadline.`)
  }
  const paragraphs: string[] = []
  for (let i = 0; i < sentences.length; i += 6) paragraphs.push(sentences.slice(i, i + 6).join(' '))
  return paragraphs.join('\n\n')
}

/** Many Bangla sentences ending with the danda, numbered so each one is unique. */
export function banglaText(count: number): string {
  const out: string[] = []
  for (let i = 0; i < count; i++) {
    out.push(`বাক্য ${i}: আমরা গ্রাহকদের জন্য নতুন সেবা চালু করেছি এবং সবাই খুশি।`)
  }
  return out.join(' ')
}

// ───────────────────────────── temp dirs ─────────────────────────────

export interface TempDir {
  dir: string
  /** Writes a file (creating sub-folders) and returns its absolute path. */
  write(name: string, data: string | Uint8Array): string
  path(name: string): string
  cleanup(): void
}

export function tempDir(prefix = 'bluely-knowledge-'): TempDir {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return {
    dir,
    write(name, data) {
      const file = join(dir, name)
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(file, data)
      return file
    },
    path: (name) => join(dir, name),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}
