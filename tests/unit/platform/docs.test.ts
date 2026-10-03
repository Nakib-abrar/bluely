import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { onboarding } from '@shared/i18n/en/onboarding'
import { settings } from '@shared/i18n/en/settings'

/**
 * The user-facing docs must describe the app as it is. These checks tie the claims that drifted
 * before (onboarding steps, Settings page names, Delete all, the installer, what PRIVACY.md says
 * is uploaded, the Windows loopback status) to the source they describe.
 */

// js-yaml ships with electron-builder (app-builder-lib), which reads electron-builder.yml with it.
const yaml = createRequire(import.meta.url)('js-yaml') as { load: (src: string) => unknown }

const ROOT = join(__dirname, '..', '..', '..')
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8')
/** Markdown with blockquote markers dropped and whitespace collapsed, so wrapped text matches. */
const flat = (md: string) => md.replace(/^> ?/gm, '').replace(/\s+/g, ' ')

const DOCS = [
  'README.md',
  'PRIVACY.md',
  'SECURITY.md',
  'CONTRIBUTING.md',
  'CHANGELOG.md',
  ...readdirSync(join(ROOT, 'docs'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => `docs/${f}`),
]

/** The body of a Markdown section, from its heading to the next heading of the same level. */
function section(md: string, heading: string): string {
  const level = /^#+/.exec(heading)?.[0] ?? '##'
  const start = md.indexOf(`\n${heading}\n`)
  if (start < 0) throw new Error(`No section "${heading}"`)
  const rest = md.slice(start + heading.length + 2)
  const end = rest.search(new RegExp(`^${level} `, 'm'))
  return end < 0 ? rest : rest.slice(0, end)
}

const readme = read('README.md')
const privacy = read('PRIVACY.md')

describe('README first run', () => {
  const firstRun = section(readme, '## First run')
  const items = firstRun
    .split(/^\d+\. /m)
    .slice(1)
    .map(flat)
  const titles = items.map((item) => /^\*\*(.+?)\*\*/.exec(item)?.[1])

  it('lists the onboarding steps in order, with their titles', () => {
    expect(items).toHaveLength(Object.keys(onboarding.steps).length)
    expect(titles).toEqual([onboarding.key.title, onboarding.audio.title, onboarding.mode.title])
  })

  it('describes what each step contains', () => {
    const [key, audio, mode] = items
    expect(key).toContain(settings.key.test)
    expect(audio).toContain(settings.audio.mic.test)
    expect(audio).toContain(settings.audio.system.test)
    // The Ask shortcut tip with the one-click Alt+Enter preset is part of the audio step.
    expect(audio).toMatch(/Alt<\/kbd>\+<kbd>Enter/)
    expect(mode).toContain(onboarding.start)
    expect(mode).toContain(onboarding.finish)
  })
})

describe('Settings page names in the docs', () => {
  const pages = Object.entries(settings.nav)
    .filter(([key]) => !['label', 'support', 'close', 'quit'].includes(key))
    .map(([, name]) => name)

  it.each(DOCS)('%s only names Settings pages that exist', (file) => {
    const text = flat(read(file))
    const bad: string[] = []
    for (const m of text.matchAll(/(Windows )?Settings › ([^›]{0,40})/g)) {
      if (m[1]) continue // Windows' own Settings app
      const after = (m[2] ?? '').replace(/^[*_]+/, '')
      if (!pages.some((page) => after.startsWith(page))) bad.push(`Settings › ${after}`)
    }
    expect(bad).toEqual([])
  })
})

describe('Delete all data', () => {
  it('README does not promise that Delete all removes everything', () => {
    const text = flat(readme)
    expect(text).not.toMatch(/Delete all data[^.]*remove everything/i)
    const sentence = /[^.]*Delete all data\*\* removes[^.]*\./.exec(text)?.[0] ?? ''
    expect(sentence).toMatch(/keeps your settings and profile, the encrypted API key/)
  })

  it('PRIVACY.md says what Delete all keeps', () => {
    const controls = flat(section(privacy, '## Your controls'))
    const bullet = /\*\*Delete all\*\*.*?(?= - \*\*|$)/.exec(controls)?.[0] ?? ''
    expect(bullet).toMatch(/keeps your settings \(including your profile\)/)
    expect(bullet).toContain('the encrypted API key')
  })
})

describe('installer', () => {
  const builder = yaml.load(read('electron-builder.yml')) as {
    nsis: { oneClick?: boolean; perMachine?: boolean }
  }

  it('README and ARCHITECTURE describe the install-mode page the NSIS config shows', () => {
    // oneClick: false + perMachine: false = assisted installer with a per-user / all-users page.
    expect(builder.nsis).toMatchObject({ oneClick: false, perMachine: false })
    const install = flat(section(readme, '## Install')).toLowerCase()
    expect(install).not.toContain('for your user only')
    expect(install).toContain('only for me')
    expect(install).toContain('anyone who uses this computer')
    const architecture = flat(read('docs', 'ARCHITECTURE.md'))
    expect(architecture).not.toContain('per-user, no admin')
    expect(architecture).toContain('"anyone who uses this computer" (elevates')
  })
})

describe('PRIVACY.md: what is sent to OpenRouter', () => {
  it('lists the microphone test recording, which is uploaded outside any session', () => {
    const openRouter = flat(
      section(privacy, '### OpenRouter (`openrouter.ai`), using your API key'),
    )
    expect(openRouter).toContain(`_${settings.audio.mic.test}_`)
    expect(openRouter).toMatch(/5-second microphone recording/)
    expect(openRouter).toMatch(/outside any session/)
  })

  it('README privacy summary mentions it too', () => {
    expect(flat(section(readme, '## Privacy'))).toContain(`_${settings.audio.mic.test}_`)
  })
})

describe('Windows loopback status of the pinned Electron', () => {
  const pin = (JSON.parse(read('package.json')) as { devDependencies: Record<string, string> })
    .devDependencies['electron']
  const verify = read('docs', 'VERIFY_LOOPBACK.md')

  it('names the same pinned version everywhere', () => {
    expect(pin).toMatch(/^\d+\.\d+\.\d+$/)
    expect(verify).toContain(`(**${pin}**)`)
    expect(verify).toContain(`npx electron@${pin} scripts/verify-loopback/main.cjs`)
    expect(readme).toContain(`Electron ${pin} (pinned exactly`)
    expect(read('docs', 'ARCHITECTURE.md')).toContain(`exact version (${pin})`)
  })

  it('records real Windows hardware separately, and says so while it is unverified', () => {
    const table = section(verify, '## Results so far')
      .split('\n')
      .filter((l) => l.startsWith('|'))
    const header = (table[0] ?? '').split('|').map((c) => c.trim())
    const col = header.findIndex((c) => /real hardware/i.test(c))
    expect(col).toBeGreaterThan(0)
    const row = table.find((l) => l.split('|')[1]?.trim() === pin)
    expect(row).toBeDefined()
    const realHardware = (row ?? '').split('|')[col]?.trim() ?? ''
    if (!realHardware.startsWith('PASS')) {
      expect(flat(verify)).toContain(
        'It **has not yet been verified on a physical Windows 10 or 11 PC**',
      )
      expect(flat(readme)).toContain('not yet been verified on a physical Windows 10/11 PC')
      expect(flat(read('docs', 'ARCHITECTURE.md'))).toContain(
        'not yet been verified on a physical Windows 10/11 PC',
      )
      expect(read('src', 'main', 'platform', 'win32', 'index.ts')).not.toMatch(/loopback works/i)
    }
  })
})
