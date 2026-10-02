import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A private PulseAudio daemon (own runtime dir + socket) for loopback tests on Linux, so the
 * machine's own sound setup is never touched. Speakers = a null sink (the loopback hears its
 * monitor); microphone = a silent null source.
 */
export interface PrivatePulse {
  env: Record<string, string>
  sink: string
  run(cmd: string, args: string[]): { ok: boolean; out: string }
  stop(): void
}

export function hasPulse(): boolean {
  if (process.platform !== 'linux') return false
  const ok = (c: string) => spawnSync('which', [c]).status === 0
  return ok('pulseaudio') && ok('pactl') && ok('paplay')
}

export function startPrivatePulse(): PrivatePulse | null {
  const dir = mkdtempSync(join(tmpdir(), 'bluely-pulse-'))
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PULSE_RUNTIME_PATH: dir,
    PULSE_STATE_PATH: dir,
    PULSE_SERVER: `unix:${join(dir, 'native')}`,
  }
  const sink = 'bluely_live_out'
  const source = 'bluely_live_mic'
  const run = (cmd: string, args: string[]) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8', env })
    return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() }
  }
  run('pulseaudio', [
    '-n',
    '--daemonize=yes',
    '--use-pid-file=yes',
    '--exit-idle-time=-1',
    '--disallow-exit',
    '-L',
    'module-native-protocol-unix auth-anonymous=1',
    '-L',
    `module-null-sink sink_name=${sink}`,
    '-L',
    `module-null-source source_name=${source}`,
  ])
  if (!run('pactl', ['info']).ok) {
    rmSync(dir, { recursive: true, force: true })
    return null
  }
  run('pactl', ['set-default-sink', sink])
  run('pactl', ['set-default-source', source])
  return {
    env,
    sink,
    run,
    stop: () => {
      run('pulseaudio', ['--kill'])
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
