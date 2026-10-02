/**
 * PDF edge cases that real pdf.js is too tolerant to reproduce with a hand-made file (a page that
 * throws), plus the exact options we hand to pdf.js. pdf.js is mocked in this file only.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { extractText } from '@main/knowledge/parsers'
import { tempDir } from './fixtures'

interface FakeItem {
  str: string
  hasEOL: boolean
  transform: number[]
  width: number
  height: number
  dir: string
  fontName: string
}

const state = vi.hoisted(() => ({
  pages: [] as (string | Error)[],
  options: [] as Record<string, unknown>[],
  destroyed: 0,
}))

vi.mock('pdfjs-dist/legacy/build/pdf.worker.mjs', () => ({ WorkerMessageHandler: {} }))
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  VerbosityLevel: { ERRORS: 0, WARNINGS: 1, INFOS: 5 },
  getDocument: (options: Record<string, unknown>) => {
    state.options.push(options)
    const doc = {
      numPages: state.pages.length,
      getPage: async (n: number) => {
        const page = state.pages[n - 1]
        if (page instanceof Error) throw page
        const item: FakeItem = {
          str: page ?? '',
          hasEOL: false,
          transform: [12, 0, 0, 12, 72, 720],
          width: 50,
          height: 12,
          dir: 'ltr',
          fontName: 'F1',
        }
        return { getTextContent: async () => ({ items: [item] }), cleanup: () => true }
      },
    }
    return {
      promise: Promise.resolve(doc),
      destroy: async () => {
        state.destroyed++
      },
    }
  },
}))

const tmp = tempDir()
afterAll(() => tmp.cleanup())

beforeEach(() => {
  state.pages = []
  state.options = []
  state.destroyed = 0
})

describe('extractText with a mocked pdf.js', () => {
  it('skips a page that fails and keeps the rest', async () => {
    state.pages = ['Page one.', new Error('broken page'), 'Page three.']
    const result = await extractText(tmp.write('partial.pdf', '%PDF-1.4 fake'))
    expect(result).toEqual({ text: 'Page one.\n\nPage three.', pages: 3 })
    expect(state.destroyed).toBe(1)
  })

  it('fails with the first page error when no page could be read', async () => {
    state.pages = [new Error('first failure\nwith details'), new Error('second failure')]
    await expect(extractText(tmp.write('dead.pdf', '%PDF-1.4 fake'))).rejects.toMatchObject({
      reason: "Couldn't read this file: first failure",
    })
    expect(state.destroyed).toBe(1)
  })

  it('passes Node-safe options and a copied Uint8Array to pdf.js', async () => {
    state.pages = ['x']
    await extractText(tmp.write('opts.pdf', '%PDF-1.4 fake'))
    const opts = state.options[0] ?? {}
    expect(opts['data']).toBeInstanceOf(Uint8Array)
    expect(Buffer.isBuffer(opts['data'])).toBe(false)
    expect(opts).toMatchObject({
      useSystemFonts: false,
      disableFontFace: true,
      isOffscreenCanvasSupported: false,
      verbosity: 0,
      cMapPacked: true,
    })
    expect(String(opts['cMapUrl'])).toMatch(/pdfjs-dist\/cmaps\/$/)
    expect(String(opts['standardFontDataUrl'])).toMatch(/pdfjs-dist\/standard_fonts\/$/)
  })
})
