# Verifying desktop audio (loopback) capture

Bluely hears the other side of a call ("Them") by capturing the Windows desktop audio mix through
Electron's `setDisplayMediaRequestHandler` with `audio: 'loopback'`. That path lives inside
Chromium and has changed between Electron versions, so Bluely pins an exact Electron version
(**43.7.7**) and ships a small, standalone verifier to check any version before upgrading.

## What the verifier does

`scripts/verify-loopback/` (`main.cjs`, `index.html`, `renderer.js`) is a dependency-free
Electron app. It works with any Electron version you start it with:

1. Registers a display-media handler that answers with the primary screen and
   `audio: 'loopback'` (the same shape Bluely uses in `src/main/windows/security.ts`). On Linux it
   also enables Chromium's `PulseaudioLoopbackForScreenShare` feature.
2. Opens a hidden, sandboxed window that calls `getDisplayMedia()` with echo cancellation, noise
   suppression and auto gain control turned off (see [below](#audio-processing-must-be-off)).
3. Plays a **1 kHz tone for 2 seconds** through the default output device at -12 dBFS. You will
   hear a short beep.
4. Records the loopback track during the tone and measures the level at 1 kHz and at 3.3 kHz
   (an unrelated frequency) with a windowed Goertzel filter, plus the RMS level.
5. Prints a result and exits with code **0 (PASS)** or **1 (FAIL)**. It gives up after 20 s.

PASS means the tone was captured at -60 dBFS or louder and at least 20 dB above the 3.3 kHz
level.

## Run it on Windows

You need [Node.js 22 LTS](https://nodejs.org) (for `npx`) and the three files from
`scripts/verify-loopback/`: clone the repository, or download `main.cjs`, `index.html` and
`renderer.js` into one folder.

1. Set your normal speakers or headset as the default playback device, unmuted, volume up.
   Close other apps that are playing sound.
2. In PowerShell, from the repository folder, run the version Bluely ships and its neighbours:

   ```powershell
   npx electron@43.7.7 scripts/verify-loopback/main.cjs
   npx electron@42.11.10 scripts/verify-loopback/main.cjs
   npx electron@44.5.1 scripts/verify-loopback/main.cjs
   ```

   From a source checkout, `pnpm verify:loopback` runs it with the pinned version. Each run
   downloads that Electron version once (about 100 MB) into the npm cache.

3. Read the last line. Example (from a Linux test machine):

   ```
   details: os=Linux 6.18.44-fc-v51 audioTracks=1 track="System audio" sampleRate=44100 rms=-15.2 margin=107.8
   LOOPBACK PASS electron=43.7.7 chrome=150.0.7871.250 platform=linux-x64 tone=-12.2 floor=-120.0
   ```

   - `tone`: captured level of the 1 kHz test tone in dBFS. About -12 means the tone came through
     at the level it was played; anything above -60 passes.
   - `floor`: level at 3.3 kHz. Very low values (-120 is digital silence) mean a clean capture;
     other audio playing at the same time raises it.
   - `audioTracks=0` or `reason: getDisplayMedia() returned no audio track` means this Electron
     version or system does not provide loopback audio at all.
   - On FAIL, a `reason:` line explains which step failed.

Options: `--verbose` prints every step (the page's logs and the track settings);
`--timeout=<ms>` changes the 20 s limit.

## Known Electron behaviour

- **Electron 33.2.1 and later throw** if `audio` in the display-media callback is a boolean. Bluely
  and the verifier pass the string `'loopback'`.
- **Electron 44** sends the display-capture permission request with an empty `mediaTypes` list.
  Bluely's permission handler accepts it (`src/main/windows/security.ts`); the verifier uses
  Electron's default handler, which grants it.
- **Electron 40.1.0** had a loopback silence regression on **macOS only**; it does not affect
  Windows builds.
- Bluely pins **43.7.7** exactly in `package.json`. Upgrade only after this verifier passes on
  Windows 10 and 11 with the new version.

## Results so far

| Electron | Chromium       | Windows 10 / 11  | Linux (PulseAudio null sink, Xvfb)          |
| -------- | -------------- | ---------------- | ------------------------------------------- |
| 42.11.10 | 148.0.7778.280 | not yet reported | PASS (tone -12.2 dBFS, floor -91.3)         |
| 43.7.7   | 150.0.7871.250 | not yet reported | PASS (tone -12.0 to -12.2 dBFS, 10 of 10 runs) |
| 44.5.1   | 152.0.7977.130 | not yet reported | PASS (tone -12.2 dBFS, floor -120)          |

The Linux results were measured in a container (see below). Please add Windows results with a
pull request or an issue: paste the full output plus your Windows version and audio device.

## Audio processing must be off

By default Chromium applies **echo cancellation, noise suppression and automatic gain control**
to the `getDisplayMedia()` audio track, even for loopback (`track.getSettings()` reports all three
as `true`). For a loopback capture that is harmful:

- echo cancellation is designed to remove audio that Chromium itself plays (such as the
  verifier's tone),
- noise suppression is designed to attenuate steady, non-speech sounds,
- the AGC adjusts the **operating system's capture volume**. In our Linux test a single run with
  default constraints turned the PulseAudio monitor source down from 100 % to 8 % (-66 dB) and
  left it there after the app exited, so every later capture (by any app) was about 66 dB too
  quiet and the verifier failed.

The verifier therefore requests
`audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }`, and
Bluely's own "Them" capture should do the same. (If a run with default constraints lowered your
monitor volume on Linux, reset it with `pactl set-source-volume <sink>.monitor 100%`.)

## If it fails

1. Rule out the setup: play a video and check that you hear it on the default device; follow
   [Troubleshooting › No system audio](TROUBLESHOOTING.md#no-system-audio-detected--the-them-side-stays-empty)
   (default device, mute, Bluetooth hands-free, exclusive mode, remote desktop).
2. Run the verifier with the pinned version **and** with older and newer versions. If only some
   versions fail, it is an Electron/Chromium regression: stay on (or pin) a passing version and
   open an issue with the outputs, Windows version and audio device.
3. If every version fails on a normal Windows setup, open an issue with `--verbose` output.

**Fallback (roadmap):** a small native **WASAPI sidecar** process that captures the render
endpoint in loopback mode (or a single process tree with the Windows 10 2004+ process-loopback
API) and streams 16 kHz PCM to Bluely's main process. It would plug in behind the same
`AudioSource` interface as the Chromium capture, so VAD, transcription and the UI stay unchanged.
Bluely would then no longer depend on Electron for desktop audio.

## Running it on Linux (development)

Desktop loopback on Linux goes through PulseAudio (or PipeWire's PulseAudio server). For a
headless container, as tested above:

```bash
pulseaudio -D --exit-idle-time=-1                     # or --start
pactl load-module module-null-sink sink_name=bluely_test
pactl set-default-sink bluely_test
pactl set-source-volume bluely_test.monitor 100%      # see the note below

# As root, Chromium needs --no-sandbox.
xvfb-run -a node_modules/electron/dist/electron --no-sandbox scripts/verify-loopback/main.cjs
```

If anything captured the monitor with Chromium's default audio processing (for example an older
build of this verifier), its AGC may have lowered `bluely_test.monitor`, and PulseAudio's
`module-device-restore` brings that low volume back even after a restart. The verifier then
reports `tone` around -78 dBFS. Check with `pactl list sources | grep -A7 bluely_test.monitor`
and reset it as above.

On a normal desktop session, `pnpm verify:loopback` is enough (as root: `pnpm verify:loopback --no-sandbox`).
