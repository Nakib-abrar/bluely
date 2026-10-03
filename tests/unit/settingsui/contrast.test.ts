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

type Rgb = [number, number, number]

function rgba(selector: string, name: string): [number, number, number, number] {
  const start = CSS.indexOf(`${selector} {`)
  const body = CSS.slice(start, CSS.indexOf('}', start))
  const m = body.match(
    new RegExp(`--${name}:\\s*rgba\\((\\d+),\\s*(\\d+),\\s*(\\d+),\\s*([\\d.]+)\\)\\s*;`),
  )
  if (!m) throw new Error(`No rgba --${name} in ${selector}`)
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
}

/** A translucent colour painted over an opaque one. */
function over([r, g, b, a]: [number, number, number, number], [R, G, B]: Rgb): Rgb {
  return [r * a + R * (1 - a), g * a + G * (1 - a), b * a + B * (1 - a)]
}

function toHex(rgb: Rgb): string {
  return `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`
}

/**
 * The overlay floats over whatever is on screen, and its surfaces are translucent and lighter than
 * the main window's: its text must stay readable on them over a black and over a white desktop.
 */
describe('overlay text contrast', () => {
  const OVERLAY_CSS = readFileSync(
    join(__dirname, '..', '..', '..', 'src/renderer/overlay/overlay.css'),
    'utf8',
  )

  it('the overlay uses its own subtle colour for secondary text', () => {
    expect(OVERLAY_CSS).toMatch(/html:root\s*\{\s*--text-subtle:\s*var\(--ov-subtle\);\s*\}/)
  })

  for (const theme of ['dark', 'light'] as const) {
    const selector = `[data-theme='${theme}']`
    const vars = tokens(selector)
    const surfaces: Record<string, string> = {}
    for (const [desk, rgb] of [
      ['black', [0, 0, 0]],
      ['white', [255, 255, 255]],
    ] as const) {
      const panel = over(rgba(selector, 'ov-panel'), [...rgb])
      surfaces[`pill over ${desk}`] = toHex(over(rgba(selector, 'ov-pill'), [...rgb]))
      surfaces[`panel over ${desk}`] = toHex(panel)
      surfaces[`input over ${desk}`] = toHex(over(rgba(selector, 'ov-input'), panel))
    }

    for (const text of ['text', 'text-muted', 'ov-subtle'] as const) {
      it(`${theme}: --${text} reaches WCAG AA (4.5:1) on the pill, panel and input`, () => {
        for (const [surface, hex] of Object.entries(surfaces)) {
          const ratio = contrast(vars[text]!, hex)
          expect(ratio, `${text} on ${surface} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5)
        }
      })
    }

    it(`${theme}: the overlay's subtle stays lighter-weight than muted`, () => {
      const onPanel = (k: string) => contrast(vars[k]!, surfaces['panel over black']!)
      expect(onPanel('text-muted')).toBeGreaterThan(onPanel('ov-subtle'))
    })
  }
})
