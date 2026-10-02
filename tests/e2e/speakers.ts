import { spawn, type ChildProcess } from 'node:child_process'
import { hasPulse, startPrivatePulse } from './pulse'

/**
 * "The PC's speakers" for live-capture tests: something that plays a WAV file on the default
 * output device, which Bluely's desktop loopback ("Them") then hears.
 *
 * - Linux: a private PulseAudio daemon with a null sink (never touches the machine's sound).
 * - Windows: the real default output device. Opt-in with BLUELY_E2E_AUDIO=1 because it plays
 *   sound out loud; CI installs a virtual sound card first (.github/workflows/loopback-windows.yml).
 */
export interface Speakers {
  /** Extra environment for the app so it uses these speakers (Linux: PULSE_SERVER). */
  appEnv: Record<string, string>
  /**
   * True when the default microphone also hears these speakers (Windows CI: the virtual cable's
   * recording side), so the Me channel transcribes an echo of the test speech.
   */
  micHearsSpeakers: boolean
  play(wavPath: string): ChildProcess
  close(): void
}

/** Why live-capture tests cannot run here, or null when they can. */
export function speakersUnavailableReason(): string | null {
  if (process.platform === 'linux') {
    return hasPulse() ? null : 'PulseAudio (pulseaudio, pactl, paplay) is not installed'
  }
  if (process.platform === 'win32') {
    return process.env['BLUELY_E2E_AUDIO'] === '1'
      ? null
      : 'Set BLUELY_E2E_AUDIO=1 to play test speech on this PC’s speakers'
  }
  return `Live capture tests do not support ${process.platform} yet`
}

export function openSpeakers(): Speakers | null {
  if (process.platform === 'linux') {
    const pulse = startPrivatePulse()
    if (!pulse) return null
    return {
      appEnv: { PULSE_SERVER: pulse.env['PULSE_SERVER'] as string },
      micHearsSpeakers: false,
      play: (wavPath) =>
        spawn('paplay', [`--device=${pulse.sink}`, wavPath], { env: pulse.env, stdio: 'ignore' }),
      close: () => pulse.stop(),
    }
  }
  if (process.platform === 'win32') {
    return {
      appEnv: {},
      micHearsSpeakers: true,
      play: (wavPath) =>
        spawn(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `(New-Object System.Media.SoundPlayer '${wavPath.replace(/'/g, "''")}').PlaySync()`,
          ],
          { stdio: 'ignore', windowsHide: true },
        ),
      close: () => undefined,
    }
  }
  return null
}
