import { mkdirSync, truncateSync, writeFileSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { KNOWLEDGE_LIMITS } from '@shared/constants'
import {
  KnowledgeError,
  decodeTextBuffer,
  extractText,
  knowledgeExtension,
  normalizeText,
} from '@main/knowledge/parsers'
import {
  BANGLA_TEXT,
  cjkPdf,
  docx,
  encryptedPdf,
  imageOnlyPdf,
  tempDir,
  textPdf,
  utf16be,
  utf16le,
  utf8,
} from './fixtures'

const tmp = tempDir()
afterAll(() => tmp.cleanup())

async function failure(path: string): Promise<string> {
  try {
    await extractText(path)
  } catch (err) {
    expect(err).toBeInstanceOf(KnowledgeError)
    return (err as KnowledgeError).reason
  }
  throw new Error(`expected ${path} to fail`)
}

describe('knowledgeExtension', () => {
  it('accepts the four supported extensions case-insensitively', () => {
    expect(knowledgeExtension('C:\\Docs\\Plan.PDF')).toBe('.pdf')
    expect(knowledgeExtension('/a/b/notes.Md')).toBe('.md')
    expect(knowledgeExtension('x.docx')).toBe('.docx')
    expect(knowledgeExtension('x.TXT')).toBe('.txt')
    expect(knowledgeExtension('x.doc')).toBeNull()
    expect(knowledgeExtension('README')).toBeNull()
    expect(knowledgeExtension('archive.pdf.zip')).toBeNull()
  })
})

describe('text decoding and normalization', () => {
  const sample = 'Pricing — “Enterprise” plan: 40 € per seat.\nআমাদের দাম।'

  it('decodes UTF-8 with and without BOM', () => {
    expect(decodeTextBuffer(utf8(sample))).toBe(sample)
    expect(decodeTextBuffer(utf8(sample, true))).toBe(sample)
  })

  it('decodes UTF-16 LE and BE by BOM', () => {
    expect(decodeTextBuffer(utf16le(sample))).toBe(sample)
    expect(decodeTextBuffer(utf16be(sample))).toBe(sample)
  })

  it('falls back to latin1 (windows-1252) for invalid UTF-8', () => {
    // "Café “quoted” – 5€" in windows-1252.
    const bytes = Buffer.from([
      0x43, 0x61, 0x66, 0xe9, 0x20, 0x93, 0x71, 0x75, 0x6f, 0x74, 0x65, 0x64, 0x94, 0x20, 0x96,
      0x20, 0x35, 0x80,
    ])
    expect(decodeTextBuffer(bytes)).toBe('Café “quoted” – 5€')
  })

  it('normalizes line endings, blank lines, trailing spaces and control characters', () => {
    const raw = '\uFEFF  Title  \r\n\r\n\r\n\r\nPara one.\t \r\nline two\u0000\r\n\n\n\nEnd   '
    expect(normalizeText(raw)).toBe('Title\n\nPara one.\nline two\n\nEnd')
  })

  it('keeps single paragraph breaks and composes Unicode (NFC)', () => {
    expect(normalizeText('a\n\nb')).toBe('a\n\nb')
    expect(normalizeText('Cafe\u0301')).toBe('Café')
  })
})

describe('extractText: text formats', () => {
  it('reads UTF-8, UTF-8 BOM and UTF-16LE .txt files', async () => {
    const text = 'Enterprise plan costs $40 per seat.\r\n\r\nSSO is included.'
    for (const [name, data] of [
      ['plain.txt', utf8(text)],
      ['bom.txt', utf8(text, true)],
      ['wide.txt', utf16le(text)],
    ] as const) {
      const result = await extractText(tmp.write(name, data))
      expect(result).toEqual({
        text: 'Enterprise plan costs $40 per seat.\n\nSSO is included.',
        pages: null,
      })
    }
  })

  it('reads Markdown as-is (markup kept)', async () => {
    const md = '# Pricing\n\n- **Starter**: $10\n- **Enterprise**: $40   \n\n\n\n## FAQ\nAsk us.'
    const { text } = await extractText(tmp.write('notes.MD', md))
    expect(text).toBe('# Pricing\n\n- **Starter**: $10\n- **Enterprise**: $40\n\n## FAQ\nAsk us.')
  })

  it('reads Bangla text', async () => {
    const { text } = await extractText(tmp.write('bangla.txt', utf8(BANGLA_TEXT)))
    expect(text).toBe(BANGLA_TEXT.normalize('NFC'))
    expect(text).toContain('দাম')
  })

  it('rejects empty and whitespace-only files', async () => {
    expect(await failure(tmp.write('empty.txt', ''))).toBe('The file is empty')
    expect(await failure(tmp.write('blank.md', ' \r\n\t\n  '))).toBe('The file is empty')
  })
})

describe('extractText: DOCX', () => {
  it('extracts paragraphs', async () => {
    const path = tmp.write(
      'brief.docx',
      docx(['Our onboarding takes two weeks.', 'Support is 24/7 & in English.']),
    )
    const result = await extractText(path)
    expect(result.pages).toBeNull()
    expect(result.text).toBe('Our onboarding takes two weeks.\n\nSupport is 24/7 & in English.')
  })

  it('reports files that are not Word documents', async () => {
    expect(await failure(tmp.write('fake.docx', 'just some text, not a zip'))).toBe(
      "Couldn't read this file: not a valid Word document",
    )
    expect(await failure(tmp.write('nodoc.docx', docx([], { omitDocument: true })))).toBe(
      "Couldn't read this file: not a valid Word document",
    )
  })

  it('rejects a document without text', async () => {
    expect(await failure(tmp.write('blank.docx', docx(['', '   '])))).toBe('The file is empty')
  })
})

describe('extractText: PDF (real pdf.js inside Electron’s Node)', () => {
  it('extracts a 2-page text PDF with line and paragraph breaks', async () => {
    const pdf = textPdf([
      [
        ['Quarterly pricing overview'],
        ['The enterprise plan costs forty dollars', 'per seat (billed yearly).'],
        ['Café discounts apply to non-profits.'],
      ],
      [['Page two covers onboarding.', 'It takes two weeks.']],
    ])
    const result = await extractText(tmp.write('pricing.pdf', pdf))
    expect(result.pages).toBe(2)
    expect(result.text).toBe(
      [
        'Quarterly pricing overview',
        '',
        'The enterprise plan costs forty dollars',
        'per seat (billed yearly).',
        '',
        'Café discounts apply to non-profits.',
        '',
        'Page two covers onboarding.',
        'It takes two weeks.',
      ].join('\n'),
    )
  })

  it('separates text runs on the same line with a space', async () => {
    const pdf = textPdf([[[['Left column', 'Right column']]]])
    const { text } = await extractText(tmp.write('runs.PDF', pdf))
    expect(text).toBe('Left column Right column')
  })

  it('maps CJK text through pdf.js character maps (cMapUrl is resolved)', async () => {
    const { text } = await extractText(tmp.write('japanese.pdf', cjkPdf('日本語の資料')))
    expect(text).toBe('日本語の資料')
  })

  it('reports PDFs without a text layer', async () => {
    expect(await failure(tmp.write('scan.pdf', imageOnlyPdf()))).toBe(
      "This PDF has no extractable text (scanned PDFs aren't supported yet)",
    )
  })

  it('reports password-protected PDFs', async () => {
    expect(await failure(tmp.write('locked.pdf', encryptedPdf()))).toBe(
      'This PDF is password-protected',
    )
  })

  it('reports files that are not PDFs', async () => {
    expect(await failure(tmp.write('fake.pdf', 'hello, I am not a PDF'))).toBe(
      "Couldn't read this file: not a valid PDF",
    )
  })

  it('can parse several PDFs concurrently', async () => {
    const paths = [1, 2, 3].map((n) =>
      tmp.write(`multi-${n}.pdf`, textPdf([[[`Document number ${n} body text.`]]])),
    )
    const results = await Promise.all(paths.map((p) => extractText(p)))
    expect(results.map((r) => r.text)).toEqual([
      'Document number 1 body text.',
      'Document number 2 body text.',
      'Document number 3 body text.',
    ])
  })
})

describe('extractText: friendly failures', () => {
  it('rejects unsupported file types before touching the file', async () => {
    expect(await failure(tmp.path('missing.doc'))).toBe('Unsupported file type')
    expect(await failure(tmp.write('notes.rtf', '{\\rtf1 hi}'))).toBe('Unsupported file type')
    expect(await failure(tmp.write('noext', 'hello'))).toBe('Unsupported file type')
  })

  it('reports missing files and folders', async () => {
    expect(await failure(tmp.path('does-not-exist.txt'))).toBe(
      "Couldn't read this file: file not found",
    )
    mkdirSync(tmp.path('folder.txt'))
    expect(await failure(tmp.path('folder.txt'))).toBe(
      "Couldn't read this file: not a regular file",
    )
  })

  it('rejects files over 20 MB without reading them (sparse file)', async () => {
    const path = tmp.write('huge.pdf', '')
    truncateSync(path, KNOWLEDGE_LIMITS.maxFileBytes + 1)
    expect(await failure(path)).toBe('File is larger than 20 MB')
  })

  it('accepts a file of exactly 20 MB (then judges its content)', async () => {
    const path = tmp.path('limit.txt')
    writeFileSync(path, '')
    truncateSync(path, KNOWLEDGE_LIMITS.maxFileBytes)
    // 20 MB of NUL bytes: allowed size, but no text once control characters are dropped.
    expect(await failure(path)).toBe('The file is empty')
  })
})
