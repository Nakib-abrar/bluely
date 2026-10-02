/** Shared helpers for the audio unit tests (not a test file itself). */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodeWav16, type DecodedWav } from '@renderer/audio/wav'
import { configureVadRuntime } from '@renderer/audio/vad'

export const ROOT = join(__dirname, '..', '..', '..')

export function fixture(name: string): DecodedWav {
  return decodeWav16(new Uint8Array(readFileSync(join(ROOT, 'tests', 'fixtures', name))))
}

export function sine(
  freq: number,
  sampleRate: number,
  seconds: number,
  amplitude = 0.5,
  phase = 0,
): Float32Array {
  const n = Math.round(sampleRate * seconds)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++)
    out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / sampleRate + phase)
  return out
}

export function concat(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

/** Deterministic pseudo-random generator (mulberry32) so failures are reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

let vadConfigured = false

/** Points the VAD at the model + WASM in node_modules (no fetch/URL in Node). */
export function useNodeVadRuntime(): void {
  if (vadConfigured) return
  vadConfigured = true
  const wasm = readFileSync(
    join(ROOT, 'node_modules', 'onnxruntime-web', 'dist', 'ort-wasm-simd-threaded.wasm'),
  )
  const model = readFileSync(
    join(ROOT, 'node_modules', '@ricky0123', 'vad-web', 'dist', 'silero_vad_v5.onnx'),
  )
  configureVadRuntime({
    async fetchModel() {
      return model.buffer.slice(model.byteOffset, model.byteOffset + model.byteLength)
    },
    configureOrt(env) {
      env.wasm.numThreads = 1
      env.wasm.wasmBinary = wasm
      env.logLevel = 'error'
    },
  })
}

/** Splits 16 kHz audio into 512-sample frames (the last partial frame is zero-padded). */
export function frames(samples: Float32Array, size = 512): Float32Array[] {
  const out: Float32Array[] = []
  for (let i = 0; i < samples.length; i += size) {
    const f = new Float32Array(size)
    f.set(samples.subarray(i, Math.min(samples.length, i + size)))
    out.push(f)
  }
  return out
}
