import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadYaml } from './yaml'

/**
 * The release job (.github/workflows/release.yml). Its publish step runs here in bash with a
 * stand-in `gh` that simulates the GitHub Release, the same way the Actions runner runs it
 * (`bash -eo pipefail`, in the step's working-directory, with VERSION in the environment).
 */

interface Step {
  name?: string
  if?: string
  run?: string
  shell?: string
  'working-directory'?: string
  env?: Record<string, string>
}

const ROOT = join(__dirname, '..', '..', '..')
const workflow = loadYaml(
  readFileSync(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8'),
) as { jobs: Record<string, { steps: Step[] }> }
const steps = Object.values(workflow.jobs).flatMap((job) => job.steps)

function step(name: string): Step {
  const found = steps.find((s) => s.name === name)
  if (!found) throw new Error(`release.yml has no step named "${name}"`)
  return found
}

const VERSION = '1.2.3'
const INSTALLERS = [`Bluely-Setup-${VERSION}.exe`, `Bluely-${VERSION}-portable.exe`]
const BUILT_FILES = [...INSTALLERS, `Bluely-Setup-${VERSION}.exe.blockmap`, 'latest.yml']

/**
 * Stand-in for the gh CLI. FAKE_GH_STATE is the release's state before the step runs
 * (missing | draft | published); FAKE_GH_FAIL_UPLOAD makes the upload of that file fail.
 */
const FAKE_GH = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_GH_LOG"
case "$1 $2" in
  "release view")
    if [ "$FAKE_GH_STATE" = missing ]; then echo "release not found" >&2; exit 1; fi
    [ "$FAKE_GH_STATE" = draft ] && echo true || echo false ;;
  "release upload")
    [ -f "$4" ] || { echo "no such file: $4" >&2; exit 1; }
    if [ "$4" = "$FAKE_GH_FAIL_UPLOAD" ]; then echo "HTTP 502 uploading $4" >&2; exit 1; fi ;;
  "release create" | "release edit") ;;
  *) echo "unexpected gh call: $*" >&2; exit 2 ;;
esac
`

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bluely-release-'))
  mkdirSync(join(dir, 'bin'))
  mkdirSync(join(dir, 'release'))
  writeFileSync(join(dir, 'bin', 'gh'), FAKE_GH)
  chmodSync(join(dir, 'bin', 'gh'), 0o755)
  // Different content per file, so every checksum is distinct.
  for (const f of BUILT_FILES) writeFileSync(join(dir, 'release', f), `contents of ${f}\n`)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function runStep(s: Step, env: Record<string, string> = {}) {
  const cwd = join(dir, s['working-directory'] ?? '.')
  const result = spawnSync(
    'bash',
    ['--noprofile', '--norc', '-eo', 'pipefail', '-c', s.run ?? ''],
    {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${join(dir, 'bin')}${delimiter}${process.env['PATH'] ?? ''}`,
        VERSION,
        GH_REPO: 'nakib-abrar/bluely',
        GH_TOKEN: 'test-token',
        GITHUB_STEP_SUMMARY: join(dir, 'summary.md'),
        FAKE_GH_LOG: join(dir, 'gh.log'),
        FAKE_GH_STATE: 'missing',
        FAKE_GH_FAIL_UPLOAD: '',
        ...env,
      },
    },
  )
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

function ghCalls(): string[] {
  try {
    return readFileSync(join(dir, 'gh.log'), 'utf8').trim().split('\n').filter(Boolean)
  } catch {
    return []
  }
}

function uploads(): string[] {
  return ghCalls()
    .filter((c) => c.startsWith('release upload'))
    .map((c) => c.split(' ')[3] ?? '')
}

/** Runs "SHA-256 checksums" then "Publish to GitHub Releases", as the job does. */
function publish(env: Record<string, string> = {}) {
  const sums = runStep(step('SHA-256 checksums'))
  expect(sums.status, sums.output).toBe(0)
  return runStep(step('Publish to GitHub Releases'), env)
}

describe('release workflow', () => {
  it('lets electron-builder package only; it never publishes (it can skip silently)', () => {
    const builderRuns = steps.filter((s) => /\belectron-builder\s+-/.test(s.run ?? ''))
    expect(builderRuns.length).toBeGreaterThan(0)
    for (const s of builderRuns) {
      expect(s.run).toMatch(/--publish never\b/)
      expect(s.run).not.toMatch(/--publish (always|onTag|onTagOrDraft)\b/)
    }
  })

  it('publishes only on PUBLISH, with bash and from release/', () => {
    const s = step('Publish to GitHub Releases')
    expect(s.if).toBe("env.PUBLISH == 'true'")
    expect(s.shell).toBe('bash')
    expect(s['working-directory']).toBe('release')
    expect(steps.indexOf(s)).toBeGreaterThan(steps.indexOf(step('SHA-256 checksums')))
  })
})

// The runner's bash is used on Windows CI; spawning `bash` from Node there may pick up WSL.
describe.skipIf(process.platform === 'win32')('release workflow publish step', () => {
  it('creates a new release as a draft and publishes it after every file, checksums last', () => {
    const { status, output } = publish({ FAKE_GH_STATE: 'missing' })
    expect(status, output).toBe(0)

    const calls = ghCalls()
    expect(calls[0]).toBe(`release view v${VERSION} --json isDraft --jq .isDraft`)
    expect(calls[1]).toMatch(new RegExp(`^release create v${VERSION} --draft --verify-tag `))
    expect(new Set(uploads())).toEqual(new Set([...BUILT_FILES, 'SHA256SUMS.txt']))
    expect(uploads().at(-1)).toBe('SHA256SUMS.txt')
    for (const c of calls.filter((c) => c.startsWith('release upload'))) {
      expect(c).toMatch(/ --clobber$/)
    }
    expect(calls.at(-1)).toBe(`release edit v${VERSION} --draft=false`)
  })

  it('uploads the installers before latest.yml, so the updater never points at a missing file', () => {
    expect(publish().status).toBe(0)
    const order = uploads()
    for (const installer of INSTALLERS) {
      expect(order.indexOf(installer)).toBeLessThan(order.indexOf('latest.yml'))
    }
  })

  it('re-publishing an old, already published release replaces every file from this build', () => {
    const { status, output } = publish({ FAKE_GH_STATE: 'published' })
    expect(status, output).toBe(0)
    expect(ghCalls().some((c) => c.startsWith('release create'))).toBe(false)
    expect(new Set(uploads())).toEqual(new Set([...BUILT_FILES, 'SHA256SUMS.txt']))
    expect(ghCalls().at(-1)).toBe(`release edit v${VERSION} --draft=false`)
  })

  it('finishes a draft left by an earlier failed run', () => {
    const { status, output } = publish({ FAKE_GH_STATE: 'draft' })
    expect(status, output).toBe(0)
    expect(ghCalls().some((c) => c.startsWith('release create'))).toBe(false)
    expect(new Set(uploads())).toEqual(new Set([...BUILT_FILES, 'SHA256SUMS.txt']))
    expect(ghCalls().at(-1)).toBe(`release edit v${VERSION} --draft=false`)
  })

  it('a failed upload fails the job before the checksums are attached or the release is published', () => {
    const { status } = publish({ FAKE_GH_FAIL_UPLOAD: INSTALLERS[1] ?? '' })
    expect(status).not.toBe(0)
    expect(uploads()).not.toContain('SHA256SUMS.txt')
    expect(ghCalls().some((c) => c.startsWith('release edit'))).toBe(false)
  })

  it('refuses to start when a built file is missing', () => {
    rmSync(join(dir, 'release', 'latest.yml'))
    const { status, output } = publish()
    expect(status).not.toBe(0)
    expect(output).toContain('latest.yml was not built')
    expect(ghCalls()).toEqual([])
  })

  it('every file listed in SHA256SUMS.txt is uploaded before SHA256SUMS.txt itself', () => {
    expect(publish().status).toBe(0)
    const listed = readFileSync(join(dir, 'release', 'SHA256SUMS.txt'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => line.split(/\s+\*?/)[1])
    expect(listed).toEqual(INSTALLERS)
    const order = uploads()
    for (const f of listed) {
      expect(order.indexOf(f ?? '')).toBeGreaterThanOrEqual(0)
      expect(order.indexOf(f ?? '')).toBeLessThan(order.indexOf('SHA256SUMS.txt'))
    }
  })
})
