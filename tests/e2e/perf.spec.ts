/**
 * Resource check (opt-in: BLUELY_PERF=1): the app idle with no session, then a live session with
 * a quiet fake microphone (room noise) and the desktop loopback. Samples CPU time and memory of
 * every Electron process via app.getAppMetrics() (all platforms; private bytes on Windows, the
 * figure Task Manager shows) plus /proc CPU ticks and PSS on Linux.
 */
import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp, type LaunchedApp } from './helpers'
import { hasPulse, startPrivatePulse, type PrivatePulse } from './pulse'

test.skip(process.env['BLUELY_PERF'] !== '1', 'Set BLUELY_PERF=1 to measure resource use')
test.setTimeout(120_000)

let ctx: LaunchedApp
let pulse: PrivatePulse | null = null

test.afterAll(async () => {
  await ctx?.app.close()
  pulse?.stop()
})

test('idle CPU and memory during a live session', async () => {
  if (hasPulse()) pulse = startPrivatePulse()
  ctx = await launchApp(
    {
      BLUELY_TEST_OPENROUTER_KEY: 'sk-or-perf-0123456789',
      ...(pulse ? { PULSE_SERVER: pulse.env['PULSE_SERVER'] as string } : {}),
    },
    [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${join(__dirname, '..', 'fixtures', 'room-noise-48k.wav')}`,
    ],
  )
  await ctx.main.evaluate(() =>
    window.bluely.invoke('settings:update', { patch: { general: { onboardingComplete: true } } }),
  )
  const sample = () =>
    ctx.app.evaluate(({ app }) =>
      app.getAppMetrics().map((m) => ({
        pid: m.pid,
        type: m.type,
        cpu: m.cpu.percentCPUUsage,
        cumulative: m.cpu.cumulativeCPUUsage ?? 0,
        workingSetMB: Math.round(m.memory.workingSetSize / 1024),
        // Windows only (KB): memory that belongs to the process alone.
        privateMB: m.memory.privateBytes != null ? Math.round(m.memory.privateBytes / 1024) : null,
      })),
    )
  type Sample = Awaited<ReturnType<typeof sample>>
  const sumCum = (xs: Sample) => xs.reduce((s, m) => s + m.cumulative, 0)
  /** CPU (% of one core, from cumulative CPU seconds) and memory over `ms`. */
  const window_ = async (label: string, ms: number) => {
    const a = await sample()
    const t0 = Date.now()
    await ctx.main.waitForTimeout(ms)
    const b = await sample()
    const secs = (Date.now() - t0) / 1000
    // Processes that exist in both samples (a renderer can come or go in between).
    const pids = new Set(a.map((m) => m.pid))
    const both = b.filter((m) => pids.has(m.pid))
    const cpu =
      ((sumCum(both) - sumCum(a.filter((m) => both.some((x) => x.pid === m.pid)))) / secs) * 100
    const ws = b.reduce((s, m) => s + m.workingSetMB, 0)
    const priv = b.every((m) => m.privateMB != null)
      ? b.reduce((s, m) => s + (m.privateMB ?? 0), 0)
      : null
    console.log(
      `[perf] ${label} (${process.platform}): CPU ${cpu.toFixed(1)}% of one core over ${secs.toFixed(0)} s; ` +
        `working set ${ws} MB${priv != null ? `; private ${priv} MB` : ''}; ` +
        `per process ${JSON.stringify(b.map((m) => [m.type, m.workingSetMB, m.privateMB]))}`,
    )
    return { cpu, ws, priv }
  }
  await ctx.main.waitForTimeout(3000) // startup work (model list, DB) settles
  await window_('app idle, no session', 10_000)
  await ctx.main.evaluate(() => window.bluely.invoke('session:start', {}))
  await expect
    .poll(
      async () => {
        const s = await ctx.main.evaluate(() => window.bluely.invoke('session:getState', undefined))
        return s.ok ? s.data.status : 'error'
      },
      { timeout: 20_000 },
    )
    .toBe('live')
  await ctx.main.waitForTimeout(8000) // let VAD/ORT warm up
  await window_('live session (room-noise mic + loopback)', 20_000)
  const a = await sample()
  // CPU ticks straight from /proc (utime + stime), independent of Electron's metrics.
  const ticks = (pid: number) => {
    try {
      const f = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]!.split(' ')
      return Number(f[11]) + Number(f[12])
    } catch {
      return 0
    }
  }
  const before = new Map(a.map((m) => [m.pid, ticks(m.pid)]))
  const t0 = Date.now()
  await ctx.main.waitForTimeout(20_000)
  const b = await sample()
  const elapsed = (Date.now() - t0) / 1000
  const procCpu = b.map((m) => ({
    type: m.type,
    pct: Number((((ticks(m.pid) - (before.get(m.pid) ?? 0)) / 100 / elapsed) * 100).toFixed(1)),
  }))
  console.log(
    `[perf] /proc CPU % of one core: ${JSON.stringify(procCpu)}; total ${procCpu.reduce((s, m) => s + m.pct, 0).toFixed(1)}%`,
  )
  const seconds = (Date.now() - t0) / 1000
  const totalMem = b.reduce((s, m) => s + m.workingSetMB, 0)
  const cpuPct = ((sumCum(b) - sumCum(a)) / seconds) * 100
  // Proportional set size (Linux): shared pages are split between the processes that map them.
  const pssMB = (pid: number) => {
    try {
      const m = /Pss:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'))
      return m ? Math.round(Number(m[1]) / 1024) : 0
    } catch {
      return 0
    }
  }
  const pss = b.map((m) => ({ type: m.type, pss: pssMB(m.pid) }))
  console.log(
    `[perf] PSS per process: ${JSON.stringify(pss)}; total PSS ${pss.reduce((s, m) => s + m.pss, 0)} MB`,
  )
  console.log(`[perf] processes: ${JSON.stringify(b)}`)
  console.log(
    `[perf] total working set ${totalMem} MB; average CPU over ${seconds.toFixed(0)} s: ${cpuPct.toFixed(1)}% of one core`,
  )
  // Experiment: same measurement with animations off (prefers-reduced-motion) on the overlay.
  const overlay = ctx.app.windows().find((w) => w.url().includes('/overlay/'))
  if (overlay && process.env['BLUELY_PERF_VARIANTS'] === '1') {
    const measure = async (label: string) => {
      const m0 = await sample()
      const t = new Map(m0.map((m) => [m.pid, ticks(m.pid)]))
      const s0 = Date.now()
      await ctx.main.waitForTimeout(10_000)
      const m1 = await sample()
      const el = (Date.now() - s0) / 1000
      const out = m1.map(
        (m) => `${m.type}:${(((ticks(m.pid) - (t.get(m.pid) ?? 0)) / 100 / el) * 100).toFixed(1)}`,
      )
      console.log(`[perf] ${label}: ${out.join(' ')}`)
    }
    await overlay.emulateMedia({ reducedMotion: 'reduce' })
    await measure('reduced motion')
    await overlay.emulateMedia({ reducedMotion: 'no-preference' })
    await ctx.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().includes('/overlay/'))
        ?.hide()
    })
    await measure('overlay hidden')
    await ctx.main.evaluate(() => window.bluely.invoke('session:stop', undefined))
    await ctx.main.waitForTimeout(3000)
    await measure('no session (app idle)')
  }
  expect(totalMem).toBeGreaterThan(0)
})
