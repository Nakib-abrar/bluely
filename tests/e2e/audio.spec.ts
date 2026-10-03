/**
 * Audio capture E2E: drives the real renderer pipeline (getUserMedia/getDisplayMedia →
 * AudioWorklet → resampler → Silero VAD → WAV) inside Electron through the dev-only harness
 * page. Needs `BLUELY_HARNESS=1 pnpm build`; skipped otherwise (e.g. in CI's normal build).
 *
 * - "fake microphone": Chromium's fake capture device plays tests/fixtures/speech-en-48k.wav.
 * - "PulseAudio loopback" (Linux only): a null sink stands in for the Windows output device,
 *   so the desktop-loopback path (main's display-media handler with audio 'loopback') can be
 *   exercised. Windows WASAPI loopback itself cannot be tested in this environment.
 */
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HarnessCaptureResult } from '../../src/renderer/harness/types'

const ROOT = join(__dirname, '..', '..')
const HARNESS_BUILT = existsSync(join(ROOT, 'out', 'renderer', 'harness', 'index.html'))
const PRELOAD = join(ROOT, 'out', 'preload', 'index.js')
const SPEECH_48K = join(ROOT, 'tests', 'fixtures', 'speech-en-48k.wav')

test.skip(!HARNESS_BUILT, 'Build the harness first: BLUELY_HARNESS=1 pnpm build')

interface Launched {
  app: ElectronApplication
  logs: string[]
}

async function launch(
  chromiumArgs: string[],
  extraEnv: Record<string, string> = {},
): Promise<Launched> {
  const userData = mkdtempSync(join(tmpdir(), 'bluely-audio-e2e-'))
  const args = [...chromiumArgs, '.']
  // Chromium refuses to start as root without this (Linux containers only).
  if (process.platform === 'linux' && process.getuid?.() === 0) args.unshift('--no-sandbox')
  const app = await electron.launch({
    args,
    cwd: ROOT,
    env: {
      ...process.env,
      BLUELY_USER_DATA_DIR: userData,
      BLUELY_TEST: '1',
      ...extraEnv,
    } as Record<string, string>,
  })
  const logs: string[] = []
  app.process().stdout?.on('data', (d) => logs.push(String(d)))
  app.process().stderr?.on('data', (d) => logs.push(String(d)))
  await app.firstWindow()
  return { app, logs }
}

/** Opens the harness in a window configured like Bluely's own (sandboxed, isolated preload). */
async function openHarness(app: ElectronApplication): Promise<Page> {
  await app.evaluate(({ BrowserWindow }, preload) => {
    const win = new BrowserWindow({
      width: 900,
      height: 600,
      title: 'Bluely audio harness',
      webPreferences: {
        preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        backgroundThrottling: false,
      },
    })
    void win.loadURL('bluely://app/harness/index.html')
  }, PRELOAD)
  let page: Page | undefined
  await expect
    .poll(() => {
      page = app.windows().find((p) => p.url().endsWith('/harness/index.html'))
      return page !== undefined
    })
    .toBe(true)
  const harness = page as Page
  harness.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') console.log(`[harness] ${msg.text()}`)
  })
  await harness.waitForFunction(() => window.__bluelyHarness !== undefined, null, {
    timeout: 20_000,
  })
  return harness
}

/** CPU % / memory of the harness renderer over `ms` (Electron app metrics). */
async function measureRenderer(app: ElectronApplication, ms: number) {
  const pid = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) =>
      w.webContents.getURL().endsWith('/harness/index.html'),
    )
    return win?.webContents.getOSProcessId() ?? -1
  })
  const read = () =>
    app.evaluate(({ app: electronApp }, target) => {
      const m = electronApp.getAppMetrics().find((p) => p.pid === target)
      return m ? { cpu: m.cpu.percentCPUUsage, memoryKb: m.memory.workingSetSize } : null
    }, pid)
  await read() // percentCPUUsage is measured since the previous call
  await new Promise((r) => setTimeout(r, ms))
  return read()
}

function describeSegments(result: HarnessCaptureResult): string {
  return result.allSegments
    .map(
      (s) =>
        `${s.channel} ${(s.durationMs / 1000).toFixed(2)}s${s.forced ? ' forced' : ''} ` +
        `(${s.wavBytes} B, vadEnd−end ${(s.vadEndAt - s.endedAt).toFixed(0)} ms)`,
    )
    .join('; ')
}

type RendererMetrics = Awaited<ReturnType<typeof measureRenderer>>

test.describe('fake microphone', () => {
  test.describe.configure({ mode: 'serial' })
  let ctx: Launched
  let page: Page
  let idleBaseline: RendererMetrics = null

  test.beforeAll(async () => {
    ctx = await launch([
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${SPEECH_48K}`,
    ])
    page = await openHarness(ctx.app)
    idleBaseline = await measureRenderer(ctx.app, 1000) // before any audio code ran
  })

  test.afterAll(async () => {
    await ctx?.app.close()
  })

  test('lists microphones and encodes WAV in the renderer', async () => {
    const mics = await page.evaluate(() => window.__bluelyHarness!.listMicrophones())
    expect(mics.length).toBeGreaterThanOrEqual(1)
    expect(mics.every((m) => m.deviceId && m.label)).toBe(true)
    const wav = await page.evaluate(() => window.__bluelyHarness!.encodeWavSelfTest())
    expect(wav).toMatchObject({ ok: true, bytes: 44 + 3200 })
  })

  test('audio:segment payloads pass preload + main validation', async () => {
    const probe = await page.evaluate(() => window.__bluelyHarness!.ipcSegmentProbe())
    // No session feature handles the channel yet, so a valid payload reaches the stub.
    expect(probe.valid).toMatch(/^(ok|not_implemented)$/)
    expect(probe.invalid).toBe('invalid_payload')
  })

  test('the capture worklet delivers 16 kHz frames in real time', async () => {
    const stats = await page.evaluate(() => window.__bluelyHarness!.measureFrames(3))
    console.log('[audio e2e] frame cadence', JSON.stringify(stats))
    expect(stats.framesPerSecond).toBeGreaterThan(29)
    expect(stats.framesPerSecond).toBeLessThan(33.5)
    expect(stats.meanRms).toBeGreaterThan(0.001) // the fixture is playing
    // Capture contexts render without opening an output device (sinkId { type: 'none' }).
    expect(stats.sink).toBe('none')
  })

  test('runMicPipeline(10) produces speech segments with valid WAVs', async () => {
    const result = await page.evaluate(() => window.__bluelyHarness!.runMicPipeline(10))
    console.log('[audio e2e] segments:', describeSegments(result))
    console.log('[audio e2e] statuses:', JSON.stringify(result.statuses))
    console.log('[audio e2e] warnings:', JSON.stringify(result.warnings))
    expect(result.statuses).toContainEqual({ channel: 'me', state: 'listening', error: null })
    expect(result.segments.length).toBeGreaterThanOrEqual(1)
    const full = result.segments.filter((s) => s.durationMs >= 1000)
    expect(full.length).toBeGreaterThanOrEqual(1)
    for (const s of result.segments) {
      expect(s.durationMs).toBeLessThanOrEqual(12_000)
      expect(s.wavValid).toBe(true)
      expect(s.wavBytes).toBe(44 + Math.round(s.audioMs * 32))
      expect(Math.abs(s.audioMs - s.durationMs)).toBeLessThan(5)
      expect(s.peak).toBeGreaterThan(0.05)
      expect(s.endedAt).toBeGreaterThan(s.startedAt)
      expect(s.vadEndAt).toBeGreaterThanOrEqual(s.endedAt - 100)
    }
    // Segments that ended on a pause are reported promptly: endedAt already includes the
    // 400 ms of trailing silence the VAD waits for, so vadEndAt follows within ~a frame.
    for (const s of full.filter((x) => !x.forced)) {
      expect(s.vadEndAt - s.endedAt).toBeLessThan(500)
    }
    expect(result.stoppedCalls).toBe(1)
    expect(result.callOrder.at(-1)).toBe('stopped')
    expect(result.snapshots).toBeLessThanOrEqual(Math.ceil((result.elapsedMs / 1000) * 15) + 2)
    expect(
      result.statuses
        .filter((s) => s.state === 'off')
        .map((s) => s.channel)
        .sort(),
    ).toEqual(['me', 'them'])
  })

  test('records a mic sample for "Test microphone"', async () => {
    const sample = await page.evaluate(() => window.__bluelyHarness!.recordMicSample(2))
    expect(sample.durationMs).toBe(2000)
    expect(sample.wavBytes).toBe(44 + 64_000)
    expect(sample.peakRms).toBeGreaterThan(0.01)
  })

  test('reports VAD cost and renderer CPU/memory while capturing', async () => {
    const bench = await page.evaluate(() => window.__bluelyHarness!.vadBenchmark(200))
    console.log(`[audio e2e] Silero inference: ${bench.msPerFrame.toFixed(3)} ms per 32 ms frame`)
    expect(bench.msPerFrame).toBeLessThan(16) // must keep up with real time by a wide margin

    const capture = page.evaluate(() => window.__bluelyHarness!.runCapture(9))
    await new Promise((r) => setTimeout(r, 2500))
    const metrics = await measureRenderer(ctx.app, 5000)
    await capture
    console.log(
      '[audio e2e] harness renderer: idle page',
      JSON.stringify(idleBaseline),
      '→ capturing speech on both channels',
      JSON.stringify(metrics),
    )
    test.info().annotations.push({
      type: 'perf',
      description: `VAD ${bench.msPerFrame.toFixed(2)} ms/frame; renderer idle ${JSON.stringify(idleBaseline)}, capturing ${JSON.stringify(metrics)}`,
    })
    expect(metrics).not.toBeNull()
  })
})

// ── Desktop loopback through a PulseAudio null sink (Linux dev boxes / containers) ─────────
//
// A private PulseAudio daemon (own runtime dir + socket) is started for these tests, so the
// user's sound setup is never touched and other processes using PulseAudio on the same
// machine cannot interfere. Electron is pointed at it with PULSE_SERVER.

const OUT_SINK = 'bluely_e2e_out'
const MIC_SOURCE = 'bluely_e2e_mic'
/** Environment pointing PulseAudio clients (pactl, paplay, Electron) at the private daemon. */
let PULSE_ENV: Record<string, string> = { ...(process.env as Record<string, string>) }

function sh(cmd: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync(cmd, args, { encoding: 'utf8', env: PULSE_ENV })
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() }
}

const HAS_PULSE =
  process.platform === 'linux' && sh('which', ['pulseaudio']).ok && sh('which', ['pactl']).ok

function sourceVolume(source: string): string {
  const info = sh('pactl', ['get-source-volume', source]).out
  return /(\d+)%/.exec(info)?.[1] ?? '?'
}

test.describe('PulseAudio loopback', () => {
  test.describe.configure({ mode: 'serial' })
  test.skip(!HAS_PULSE, 'PulseAudio is not installed')

  let ctx: Launched
  let page: Page

  test.beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bluely-pulse-'))
    PULSE_ENV = {
      ...PULSE_ENV,
      PULSE_RUNTIME_PATH: dir,
      PULSE_STATE_PATH: dir,
      PULSE_SERVER: `unix:${join(dir, 'native')}`,
    }
    const started = sh('pulseaudio', [
      '-n', // no default.pa: only the modules below
      '--daemonize=yes',
      '--use-pid-file=yes',
      '--exit-idle-time=-1',
      '--disallow-exit',
      '-L',
      'module-native-protocol-unix auth-anonymous=1',
      '-L',
      `module-null-sink sink_name=${OUT_SINK}`,
      '-L',
      `module-null-source source_name=${MIC_SOURCE}`,
    ])
    if (!sh('pactl', ['info']).ok) {
      test.skip(true, `Could not start a private PulseAudio daemon: ${started.out}`)
      return
    }
    // Speakers = OUT_SINK (the loopback hears its monitor). Microphone = a silent null source
    // (Chromium does not list monitor sources as microphones).
    sh('pactl', ['set-default-sink', OUT_SINK])
    sh('pactl', ['set-default-source', MIC_SOURCE])
    ctx = await launch([], { PULSE_SERVER: PULSE_ENV['PULSE_SERVER'] as string })
    page = await openHarness(ctx.app)
  })

  test.afterAll(async () => {
    await ctx?.app.close()
    sh('pulseaudio', ['--kill'])
    const dir = PULSE_ENV['PULSE_RUNTIME_PATH']
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  test('loopback capture runs without voice processing (no AEC/NS/AGC)', async () => {
    const settings = await page.evaluate(() => window.__bluelyHarness!.trackSettings())
    console.log('[audio e2e] track settings:', JSON.stringify(settings))
    expect(settings.loopbackError).toBeNull()
    expect(settings.loopback).toMatchObject({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    })
    expect(settings.mic).toMatchObject({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    })
  })

  test('testSystemAudio() hears its own tone through the loopback', async () => {
    const result = await page.evaluate(() => window.__bluelyHarness!.testSystemAudio())
    console.log(
      '[audio e2e] testSystemAudio:',
      JSON.stringify(result),
      `(loopback source volume ${sourceVolume(`${OUT_SINK}.monitor`)}%)`,
    )
    expect(result.reason).toBeNull()
    expect(result.ok).toBe(true)
    expect(result.detectedDb).not.toBeNull()
    expect(result.detectedDb!).toBeGreaterThan(-30)
  })

  test('idle capture (silent mic and system audio) is cheap', async () => {
    const capture = page.evaluate(() => window.__bluelyHarness!.runCapture(9))
    await new Promise((r) => setTimeout(r, 2500))
    const metrics = await measureRenderer(ctx.app, 5000)
    const result = await capture
    console.log('[audio e2e] harness renderer, idle capture:', JSON.stringify(metrics))
    test.info().annotations.push({ type: 'perf', description: `idle ${JSON.stringify(metrics)}` })
    expect(result.allSegments).toHaveLength(0)
    // The null-source "mic" delivers exact zeros: after 5 s that reads as a muted mic, and
    // stop() clears the warning again. start() first clears every capture warning a previous
    // renderer may have left set in main.
    console.log('[audio e2e] idle warnings:', JSON.stringify(result.warnings))
    expect(result.warnings).toEqual([
      ...[
        'mic_not_found',
        'mic_denied',
        'loopback_unavailable',
        'no_system_audio',
        'mic_muted',
      ].map((code) => ({ code, active: false })),
      { code: 'mic_muted', active: true },
      { code: 'mic_muted', active: false },
    ])
    expect(metrics).not.toBeNull()
  })

  test('the Them channel transcribes audio played on the default output', async () => {
    let player: ChildProcess | null = null
    const capture = page.evaluate(() => window.__bluelyHarness!.runCapture(11))
    await new Promise((r) => setTimeout(r, 1500)) // let both channels start listening
    player = spawn('paplay', [`--device=${OUT_SINK}`, SPEECH_48K], {
      stdio: 'ignore',
      env: PULSE_ENV,
    })
    const result = await capture
    player.kill()
    console.log('[audio e2e] loopback segments:', describeSegments(result))
    console.log('[audio e2e] statuses:', JSON.stringify(result.statuses))
    expect(result.statuses).toContainEqual({ channel: 'them', state: 'listening', error: null })
    const them = result.allSegments.filter((s) => s.channel === 'them')
    expect(them.length).toBeGreaterThanOrEqual(1)
    // The fixture is ~6.2 s of speech in two phrases with a ~350 ms pause between them, just
    // under the VAD's 400 ms redemption window. Depending on frame alignment the phrases
    // arrive as one ~6.4 s segment or as two ~3.2 s ones, so check that the speech was
    // captured as whole phrases rather than where the VAD split it.
    expect(them.reduce((sum, s) => sum + s.durationMs, 0)).toBeGreaterThan(5000)
    expect(Math.max(...them.map((s) => s.durationMs))).toBeGreaterThan(2500)
    for (const s of them) {
      expect(s.wavValid).toBe(true)
      expect(s.durationMs).toBeLessThanOrEqual(12_000)
    }
    // The microphone (a silent null source) produced nothing.
    expect(result.segments).toHaveLength(0)
  })
})
