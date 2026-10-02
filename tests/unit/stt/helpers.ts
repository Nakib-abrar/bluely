import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Logger } from '@main/log'
import type { FetchLike, RequestInitLike, ResponseLike } from '@main/providers/openrouterHttp'
import type { TranscriptionResult } from '@main/providers/stt/STTProvider'

export const FIXTURES = fileURLToPath(new URL('../../fixtures/', import.meta.url))

export function fixture(name: string): Uint8Array {
  const buf = readFileSync(join(FIXTURES, name))
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}

export interface WavOptions {
  sampleRate?: number
  channels?: number
  /** Extra chunks inserted between `fmt ` and `data` (e.g. LIST). */
  extraChunks?: { id: string; body: Uint8Array }[]
  /** Overrides the declared data chunk size (to simulate truncation). */
  declaredDataBytes?: number
}

function chunk(id: string, body: Uint8Array): Uint8Array {
  const pad = body.byteLength & 1
  const out = new Uint8Array(8 + body.byteLength + pad)
  const view = new DataView(out.buffer)
  for (let i = 0; i < 4; i++) out[i] = id.charCodeAt(i)
  view.setUint32(4, body.byteLength, true)
  out.set(body, 8)
  return out
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.byteLength
  }
  return out
}

/** fmt chunk body for integer PCM / float / extensible formats. */
export function fmtBody(opts: {
  format?: number
  channels?: number
  sampleRate?: number
  bits?: number
  subFormat?: number
}): Uint8Array {
  const format = opts.format ?? 1
  const channels = opts.channels ?? 1
  const sampleRate = opts.sampleRate ?? 16000
  const bits = opts.bits ?? 16
  const extensible = format === 0xfffe
  const body = new Uint8Array(extensible ? 40 : 16)
  const v = new DataView(body.buffer)
  v.setUint16(0, format, true)
  v.setUint16(2, channels, true)
  v.setUint32(4, sampleRate, true)
  v.setUint32(8, (sampleRate * channels * bits) / 8, true)
  v.setUint16(12, (channels * bits) / 8, true)
  v.setUint16(14, bits, true)
  if (extensible) {
    v.setUint16(16, 22, true)
    v.setUint16(18, bits, true)
    v.setUint32(20, channels === 1 ? 4 : 3, true)
    v.setUint16(24, opts.subFormat ?? 1, true)
  }
  return body
}

/** Builds a RIFF/WAVE file around raw sample bytes. */
export function wavFromBytes(data: Uint8Array, fmt: Uint8Array, opts: WavOptions = {}): Uint8Array {
  const dataChunk = chunk('data', data)
  if (opts.declaredDataBytes != null) {
    new DataView(dataChunk.buffer).setUint32(4, opts.declaredDataBytes, true)
  }
  const body = concat([
    new Uint8Array([0x57, 0x41, 0x56, 0x45]), // WAVE
    chunk('fmt ', fmt),
    ...(opts.extraChunks ?? []).map((c) => chunk(c.id, c.body)),
    dataChunk,
  ])
  const header = new Uint8Array(8)
  const v = new DataView(header.buffer)
  for (let i = 0; i < 4; i++) header[i] = 'RIFF'.charCodeAt(i)
  v.setUint32(4, body.byteLength, true)
  return concat([header, body])
}

/** 16-bit PCM WAV from float samples in -1..1. */
export function makeWav(samples: ArrayLike<number>, opts: WavOptions = {}): Uint8Array {
  const data = new Uint8Array(samples.length * 2)
  const v = new DataView(data.buffer)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0))
    v.setInt16(i * 2, Math.round(s * 32767), true)
  }
  return wavFromBytes(
    data,
    fmtBody({ channels: opts.channels ?? 1, sampleRate: opts.sampleRate ?? 16000 }),
    opts,
  )
}

export function silence(seconds: number, sampleRate = 16000): Float32Array {
  return new Float32Array(Math.round(seconds * sampleRate))
}

export function tone(seconds: number, amplitude: number, freq = 440, sampleRate = 16000) {
  const out = new Float32Array(Math.round(seconds * sampleRate))
  for (let i = 0; i < out.length; i++) {
    out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / sampleRate)
  }
  return out
}

export function joinSamples(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/** A WAV that passes the silence check (1 s, 440 Hz at -12 dBFS). */
export function speechLikeWav(seconds = 1): Uint8Array {
  return makeWav(tone(seconds, 0.25))
}

export interface LogEntry {
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
  extra: unknown
}

/** Logger that records instead of printing. */
export function memoryLogger(entries: LogEntry[] = []): Logger & { entries: LogEntry[] } {
  const make = (): Logger & { entries: LogEntry[] } => ({
    entries,
    debug: (message, extra) => entries.push({ level: 'debug', message, extra }),
    info: (message, extra) => entries.push({ level: 'info', message, extra }),
    warn: (message, extra) => entries.push({ level: 'warn', message, extra }),
    error: (message, extra) => entries.push({ level: 'error', message, extra }),
    child: () => make(),
    setDebug: () => undefined,
  })
  return make()
}

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): ResponseLike {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => h.get(name.toLowerCase()) ?? null },
    body: null,
    text: async () => text,
    json: async () => JSON.parse(text) as unknown,
  }
}

export interface RecordedRequest {
  url: string
  init: RequestInitLike
  body: Record<string, unknown>
}

/** Fake fetch that records requests and answers with `respond`. */
export function recordingFetch(
  respond: (req: RecordedRequest) => ResponseLike | Promise<ResponseLike>,
): FetchLike & { requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = []
  const fn = (async (url: string, init: RequestInitLike) => {
    const req: RecordedRequest = {
      url,
      init,
      body: init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {},
    }
    requests.push(req)
    return respond(req)
  }) as FetchLike & { requests: RecordedRequest[] }
  fn.requests = requests
  return fn
}

export function sttResult(text: string, extra: Partial<TranscriptionResult> = {}) {
  return {
    text,
    model: 'openai/whisper-large-v3-turbo',
    latencyMs: 120,
    costUsd: 0.0001,
    audioSeconds: 1,
    language: null,
    ...extra,
  } satisfies TranscriptionResult
}

/** Lets queued microtasks and promise chains settle (works with fake timers too). */
export async function flushMicrotasks(rounds = 25): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve()
}

export interface Deferred<T> {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
