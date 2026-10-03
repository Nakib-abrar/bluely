import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Text colours must stay readable on the surfaces they are used on (spec §11 accessibility):
 * WCAG AA asks for 4.5:1 for normal-size text, and the subtle colour is used for real 11-12.5 px
 * labels (day headings, status lines, table headers).
 */
const CSS = readFileSync(
  join(__dirname, '..', '..', '..', 'src/renderer/styles/globals.css'),
  'utf8',
)

function tokens(selector: string): Record<string, string> {
  const start = CSS.indexOf(`${selector} {`)
  if (start < 0) throw new Error(`No ${selector} block in globals.css`)
  const body = CSS.slice(start, CSS.indexOf('}', start))
  const out: Record<string, string> = {}
  for (const m of body.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)) out[m[1]!] = m[2]!
  return out
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

describe('theme text contrast', () => {
  const themes = {
    dark: tokens("[data-theme='dark']"),
    light: tokens("[data-theme='light']"),
  }
  const surfaces = ['bg', 'panel', 'panel-2', 'panel-3'] as const

  for (const [theme, vars] of Object.entries(themes)) {
    for (const text of ['text', 'text-muted', 'text-subtle'] as const) {
      it(`${theme}: --${text} reaches WCAG AA (4.5:1) on every panel surface`, () => {
        for (const surface of surfaces) {
          const ratio = contrast(vars[text]!, vars[surface]!)
          expect(ratio, `${text} on ${surface} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5)
        }
      })
    }

    it(`${theme}: subtle stays visibly lighter-weight than muted`, () => {
      // Hierarchy: fg > muted > subtle, measured against the page background.
      const onBg = (k: string) => contrast(vars[k]!, vars['bg']!)
      expect(onBg('text-muted')).toBeGreaterThan(onBg('text-subtle'))
    })
  }

  it('computes known WCAG ratios', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5)
    expect(contrast('#71717a', '#1e1e21')).toBeCloseTo(3.44, 2)
  })
})
