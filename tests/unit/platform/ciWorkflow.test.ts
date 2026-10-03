import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadYaml } from './yaml'

/**
 * The CI workflow (.github/workflows/ci.yml). Some unit suites only run on a POSIX shell
 * (releaseWorkflow.test.ts skips its publish-step tests on win32) and the capture E2E with
 * PulseAudio loopback only exists on Linux, so CI needs a Linux job next to the Windows one.
 */

interface Step {
  name?: string
  uses?: string
  run?: string
  env?: Record<string, string>
}
interface Job {
  'runs-on': string
  steps: Step[]
}

const ROOT = join(__dirname, '..', '..', '..')
const ci = loadYaml(readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')) as {
  jobs: Record<string, Job>
}
const jobs = Object.values(ci.jobs)
const runs = (job: Job) => job.steps.map((s) => (s.run ?? '').replace(/\s+/g, ' ').trim())
const indexOfRun = (job: Job, re: RegExp) => runs(job).findIndex((r) => re.test(r))

describe('CI workflow', () => {
  const windows = jobs.filter((j) => j['runs-on'].startsWith('windows-'))
  const linux = jobs.filter((j) => j['runs-on'].startsWith('ubuntu-'))

  it('keeps the Windows job: typecheck, lint, format, unit tests, build and the E2E suite', () => {
    expect(windows).toHaveLength(1)
    const job = windows[0] as Job
    for (const cmd of [
      /^pnpm typecheck$/,
      /^pnpm lint$/,
      /^pnpm format:check$/,
      /^pnpm test$/,
      /^pnpm build$/,
      /^pnpm exec playwright test$/,
    ]) {
      expect(indexOfRun(job, cmd), String(cmd)).toBeGreaterThanOrEqual(0)
    }
  })

  it('has a Linux job that runs typecheck, lint and every unit test (incl. the POSIX-only ones)', () => {
    expect(linux).toHaveLength(1)
    const job = linux[0] as Job
    expect(indexOfRun(job, /^pnpm install --frozen-lockfile$/)).toBeGreaterThanOrEqual(0)
    expect(indexOfRun(job, /^pnpm typecheck$/)).toBeGreaterThanOrEqual(0)
    expect(indexOfRun(job, /^pnpm lint$/)).toBeGreaterThanOrEqual(0)
    // The whole suite, not a filtered subset.
    expect(indexOfRun(job, /^pnpm test$/)).toBeGreaterThanOrEqual(0)
  })

  it('runs the Linux capture E2E on a harness build with PulseAudio, under Xvfb', () => {
    const job = linux[0] as Job
    const apt = indexOfRun(job, /apt-get install .*\bpulseaudio\b.*\bpulseaudio-utils\b.*\bxvfb\b/)
    const build = job.steps.findIndex((s) => s.run === 'pnpm build' && s.env?.['BLUELY_HARNESS'])
    const e2e = indexOfRun(job, /^xvfb-run .*pnpm exec playwright test /)
    expect(apt).toBeGreaterThanOrEqual(0)
    expect(build).toBeGreaterThan(apt)
    expect(e2e).toBeGreaterThan(build)
    const cmd = runs(job)[e2e] ?? ''
    expect(cmd).toContain('tests/e2e/audio.spec.ts')
    expect(cmd).toContain('tests/e2e/liveaudio.spec.ts')
  })

  it('keeps Electron sandboxed on the Linux runner (it is not root)', () => {
    const job = linux[0] as Job
    expect(runs(job).join('\n')).not.toContain('--no-sandbox')
    // Ubuntu 23.10+ blocks the user namespaces the sandbox needs unless this is lifted.
    const sysctl = indexOfRun(job, /sysctl -w kernel\.apparmor_restrict_unprivileged_userns=0/)
    expect(sysctl).toBeGreaterThanOrEqual(0)
    expect(sysctl).toBeLessThan(indexOfRun(job, /^xvfb-run /))
  })
})
