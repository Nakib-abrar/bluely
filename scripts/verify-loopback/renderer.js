// Page side of the loopback verifier (see main.cjs). Runs sandboxed without Node; main calls
// window.runLoopbackTest() and receives a plain result object.
/* global window, AudioContext, MediaStream */
'use strict'

const TONE_HZ = 1000
// Not a harmonic of 1 kHz: measures how much else (noise, leakage, other audio) is captured.
const PROBE_HZ = 3300
const TONE_MS = 2000
// Keep recording after the tone so output + loopback latency does not cut it off.
const TAIL_MS = 600
const TONE_GAIN = 0.25
const BLOCK = 4096
// Audio output devices can take a while to start; the test waits for the audio clock.
const CLOCK_START_TIMEOUT_MS = 5000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const log = (...parts) => console.log(parts.join(' '))

/** Polls `predicate` every 20 ms; resolves true when it holds, false after `timeoutMs`. */
async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) return false
    await sleep(20)
  }
  return true
}

/** Windowed (Hann) Goertzel: amplitude of `freq` in samples[start, start+n), 1.0 = full scale. */
function goertzelAmplitude(samples, start, n, freq, sampleRate) {
  const coeff = 2 * Math.cos((2 * Math.PI * freq) / sampleRate)
  let s1 = 0
  let s2 = 0
  for (let i = 0; i < n; i++) {
    const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))
    const s0 = samples[start + i] * hann + coeff * s1 - s2
    s2 = s1
    s1 = s0
  }
  const power = Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2)
  // |X| ≈ A·N/2 for a sine of amplitude A; the Hann window halves it (coherent gain 0.5).
  return (2 * Math.sqrt(power)) / (n * 0.5)
}

function rms(samples, start, n) {
  let sum = 0
  for (let i = start; i < start + n; i++) sum += samples[i] * samples[i]
  return Math.sqrt(sum / n)
}

const toDb = (amplitude) => 20 * Math.log10(Math.max(amplitude, 1e-6))

function analyse(samples, sampleRate) {
  const blocks = []
  for (let start = 0; start + BLOCK <= samples.length; start += BLOCK) {
    blocks.push({
      tone: goertzelAmplitude(samples, start, BLOCK, TONE_HZ, sampleRate),
      probe: goertzelAmplitude(samples, start, BLOCK, PROBE_HZ, sampleRate),
      rms: rms(samples, start, BLOCK),
    })
  }
  if (!blocks.length) return null
  // Average over the blocks where the tone is present (within 6 dB of its peak), so loopback
  // latency and the silent tail do not dilute the measurement.
  const peak = Math.max(...blocks.map((b) => b.tone))
  const active = blocks.filter((b) => b.tone >= peak / 2)
  const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length
  return {
    toneDb: toDb(mean(active.map((b) => b.tone))),
    floorDb: toDb(mean(active.map((b) => b.probe))),
    rmsDb: toDb(Math.sqrt(mean(active.map((b) => b.rms * b.rms)))),
    blocks: blocks.length,
    activeBlocks: active.length,
  }
}

async function runLoopbackTest() {
  const result = { audioTracks: 0, trackLabel: '', sampleRate: null }
  let stream = null
  let ctx = null
  try {
    try {
      // Chromium enables echo cancellation, noise suppression and auto gain control on the
      // loopback track by default: AEC cancels our own tone, NS suppresses steady tones, and the
      // AGC may even turn down the OS capture volume (seen with PulseAudio: monitor at 8%).
      // Turn them all off to measure the raw capture path.
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      })
    } catch (err) {
      return { ...result, error: `getDisplayMedia() failed: ${err.name}: ${err.message}` }
    }
    const tracks = stream.getAudioTracks()
    result.audioTracks = tracks.length
    if (!tracks.length) {
      return {
        ...result,
        error: 'getDisplayMedia() returned no audio track: loopback capture is not supported here',
      }
    }
    const track = tracks[0]
    result.trackLabel = track.label
    log(`audio track: "${track.label}" readyState=${track.readyState} muted=${track.muted}`)
    log(`track settings: ${JSON.stringify(track.getSettings ? track.getSettings() : {})}`)

    ctx = new AudioContext()
    await ctx.resume()
    result.sampleRate = ctx.sampleRate

    // Capture: loopback track → ScriptProcessor (copies samples) → muted gain → destination.
    // The processor must reach the destination to run; the gain of 0 avoids a feedback loop.
    const source = ctx.createMediaStreamSource(new MediaStream([track]))
    const recorder = ctx.createScriptProcessor(BLOCK, 1, 1)
    const mute = ctx.createGain()
    mute.gain.value = 0
    const chunks = []
    let recording = false
    recorder.onaudioprocess = (e) => {
      if (recording) chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)))
    }
    source.connect(recorder)
    recorder.connect(mute)
    mute.connect(ctx.destination)

    // Playback: a 1 kHz sine at -12 dBFS through the default output device.
    const osc = ctx.createOscillator()
    osc.frequency.value = TONE_HZ
    const gain = ctx.createGain()
    gain.gain.value = 0
    osc.connect(gain)
    gain.connect(ctx.destination)

    // Schedule on the audio clock, not wall time: the output device may need a second or more
    // to start, and the wall clock would then cut the tone short.
    recording = true
    if (!(await waitFor(() => ctx.currentTime > 0.05, CLOCK_START_TIMEOUT_MS))) {
      return { ...result, error: 'the audio output clock did not start (no output device?)' }
    }
    const start = ctx.currentTime + 0.1
    const stop = start + TONE_MS / 1000
    // 20 ms fades: hard starts/stops click, and clicks spread energy into the 3.3 kHz probe.
    gain.gain.setValueAtTime(0, start)
    gain.gain.linearRampToValueAtTime(TONE_GAIN, start + 0.02)
    gain.gain.setValueAtTime(TONE_GAIN, stop - 0.02)
    gain.gain.linearRampToValueAtTime(0, stop)
    osc.start(start)
    osc.stop(stop)
    const latency = (ctx.outputLatency || 0) + (ctx.baseLatency || 0)
    log(`playing ${TONE_HZ} Hz for ${TONE_MS} ms at ${ctx.sampleRate} Hz (latency ${latency})`)
    const end = stop + TAIL_MS / 1000 + latency
    await waitFor(() => ctx.currentTime >= end, TONE_MS + TAIL_MS + CLOCK_START_TIMEOUT_MS)
    recording = false

    const total = chunks.reduce((n, c) => n + c.length, 0)
    const samples = new Float32Array(total)
    let offset = 0
    for (const c of chunks) {
      samples.set(c, offset)
      offset += c.length
    }
    log(`captured ${total} samples (${((total / ctx.sampleRate) * 1000).toFixed(0)} ms)`)
    const metrics = analyse(samples, ctx.sampleRate)
    if (!metrics) return { ...result, error: 'no audio samples were captured' }
    log(`blocks=${metrics.blocks} active=${metrics.activeBlocks}`)
    return { ...result, ...metrics }
  } catch (err) {
    return { ...result, error: `test page error: ${err && err.message ? err.message : err}` }
  } finally {
    if (stream) stream.getTracks().forEach((t) => t.stop())
    if (ctx) await ctx.close().catch(() => undefined)
  }
}

window.runLoopbackTest = runLoopbackTest
