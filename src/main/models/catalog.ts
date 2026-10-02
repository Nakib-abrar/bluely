import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import type { ModelInfo, ModelPricing } from '@shared/types'
import type { Logger } from '../log'
import { ProviderError } from '../providers/errors'
import type { OpenRouterHttp } from '../providers/openrouterHttp'

export { validateDefaults, pickBestModel, isRoleCompatible } from './validate'

/** Refetch the list when the cached copy is older than this. */
export const MODEL_CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000

/** Speech-to-text model ids (OpenRouter /audio/transcriptions). */
const STT_ID = /whisper|voxtral|transcribe|speech-to-text|parakeet|canary|scribe/i

// ───────────────────────────── parsing ─────────────────────────────

/** OpenRouter prices are strings in USD per token; "-1" marks variable pricing (router models). */
export function parsePrice(value: unknown): number | null {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : NaN
  return Number.isFinite(n) && n >= 0 ? n : null
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const out = value
    .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    .map((v) => v.trim().toLowerCase())
  return [...new Set(out)]
}

/** Parses the legacy `architecture.modality` string, e.g. "text+image->text". */
export function parseModalityString(modality: unknown): { input: string[]; output: string[] } {
  if (typeof modality !== 'string' || !modality.includes('->')) return { input: [], output: [] }
  const [inp = '', outp = ''] = modality.split('->')
  const split = (s: string) => [
    ...new Set(
      s
        .split('+')
        .map((p) => p.trim().toLowerCase())
        .filter((p) => p.length > 0),
    ),
  ]
  return { input: split(inp), output: split(outp) }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function positiveInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : null
}

/** True for models usable with /audio/transcriptions. */
export function looksLikeStt(id: string, input: string[], output: string[]): boolean {
  if (STT_ID.test(id)) return true
  return input.length === 1 && input[0] === 'audio' && output.includes('text')
}

/** Parses one entry of GET /models `data[]`. Returns null for entries without an id. */
export function parseModel(raw: unknown): ModelInfo | null {
  if (!isRecord(raw)) return null
  const id = typeof raw['id'] === 'string' ? raw['id'].trim() : ''
  if (!id) return null
  const arch = isRecord(raw['architecture']) ? raw['architecture'] : {}
  const fromString = parseModalityString(arch['modality'])
  const inputModalities = stringList(arch['input_modalities']) ?? fromString.input
  const outputModalities = stringList(arch['output_modalities']) ?? fromString.output
  const p = isRecord(raw['pricing']) ? raw['pricing'] : {}
  const pricing: ModelPricing = {
    prompt: parsePrice(p['prompt']),
    completion: parsePrice(p['completion']),
    request: parsePrice(p['request']),
    image: parsePrice(p['image']),
    audio: parsePrice(p['audio']),
  }
  const top = isRecord(raw['top_provider']) ? raw['top_provider'] : {}
  const name = typeof raw['name'] === 'string' && raw['name'].trim() ? raw['name'].trim() : id
  const description =
    typeof raw['description'] === 'string' && raw['description'].trim()
      ? raw['description'].trim()
      : null
  return {
    id,
    name,
    contextLength: positiveInt(raw['context_length']) ?? positiveInt(top['context_length']),
    pricing,
    inputModalities,
    outputModalities,
    supportsVision: inputModalities.includes('image'),
    supportsAudioInput: inputModalities.includes('audio'),
    isStt: looksLikeStt(id, inputModalities, outputModalities),
    description,
  }
}

/** Parses a GET /models response (`{ data: [...] }`). Duplicate ids keep the first entry. */
export function parseModelList(json: unknown): ModelInfo[] {
  const data = isRecord(json) ? json['data'] : null
  if (!Array.isArray(data)) return []
  const seen = new Set<string>()
  const out: ModelInfo[] = []
  for (const raw of data) {
    const m = parseModel(raw)
    if (!m || seen.has(m.id)) continue
    seen.add(m.id)
    out.push(m)
  }
  return out
}

// ───────────────────────────── disk cache ─────────────────────────────

const pricingSchema = z.object({
  prompt: z.number().nullable(),
  completion: z.number().nullable(),
  request: z.number().nullable(),
  image: z.number().nullable(),
  audio: z.number().nullable(),
})

const modelInfoSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  contextLength: z.number().nullable(),
  pricing: pricingSchema,
  inputModalities: z.array(z.string()),
  outputModalities: z.array(z.string()),
  supportsVision: z.boolean(),
  supportsAudioInput: z.boolean(),
  isStt: z.boolean(),
  description: z.string().nullable(),
})

const cacheFileSchema = z.object({
  fetchedAt: z.number(),
  models: z.array(modelInfoSchema),
})

export type ModelCacheFile = z.infer<typeof cacheFileSchema>

// ───────────────────────────── catalog ─────────────────────────────

export interface ModelCatalogOptions {
  http: OpenRouterHttp
  log: Logger
  /** JSON cache `{ fetchedAt, models }` so startup and pickers work offline. */
  cacheFile: string
  /** Wall clock (ms since epoch). */
  now?: () => number
  maxAgeMs?: number
}

/**
 * The OpenRouter model list (chat + STT), cached in memory and on disk. `list()` never throws:
 * on network failure it serves the last known list (or [] with a warning).
 */
export class ModelCatalog {
  private readonly http: OpenRouterHttp
  private readonly log: Logger
  private readonly cacheFile: string
  private readonly now: () => number
  private readonly maxAgeMs: number
  private models: ModelInfo[] | null = null
  private byId = new Map<string, ModelInfo>()
  private fetchedAtMs = 0
  private diskLoad: Promise<void> | null = null
  private inflight: Promise<ModelInfo[]> | null = null

  constructor(opts: ModelCatalogOptions) {
    this.http = opts.http
    this.log = opts.log
    this.cacheFile = opts.cacheFile
    this.now = opts.now ?? Date.now
    this.maxAgeMs = opts.maxAgeMs ?? MODEL_CACHE_MAX_AGE_MS
  }

  /** Epoch ms of the list currently served (0 = never fetched). */
  get fetchedAt(): number {
    return this.fetchedAtMs
  }

  /** Returns the model list, fetching when the cache is missing, stale or `refresh` is set. */
  async list(opts: { refresh?: boolean } = {}): Promise<ModelInfo[]> {
    await this.loadDiskOnce()
    const fresh = this.models !== null && this.now() - this.fetchedAtMs < this.maxAgeMs
    if (fresh && !opts.refresh && this.models) return this.models
    // Concurrent callers (startup validation + Settings opening) share one request.
    this.inflight ??= this.fetchAndStore().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  /** The currently cached list (no network). */
  snapshot(): ModelInfo[] {
    return this.models ?? []
  }

  getById(id: string): ModelInfo | null {
    return this.byId.get(id) ?? null
  }

  sttModels(): ModelInfo[] {
    return this.snapshot().filter((m) => m.isStt)
  }

  visionModels(): ModelInfo[] {
    return this.snapshot().filter((m) => m.supportsVision && !m.isStt)
  }

  chatModels(): ModelInfo[] {
    return this.snapshot().filter((m) => !m.isStt)
  }

  private setModels(models: ModelInfo[], fetchedAt: number): void {
    this.models = models
    this.fetchedAtMs = fetchedAt
    this.byId = new Map(models.map((m) => [m.id, m]))
  }

  private async fetchAndStore(): Promise<ModelInfo[]> {
    try {
      const models = parseModelList(await this.fetchRaw())
      // OpenRouter always lists hundreds of models; an empty list means a broken response.
      if (models.length === 0) throw new ProviderError('server', { detail: 'Empty model list' })
      const fetchedAt = this.now()
      this.setModels(models, fetchedAt)
      await this.saveDisk({ fetchedAt, models })
      this.log.info(`Model list refreshed (${models.length} models)`)
      return models
    } catch (err) {
      const cached = this.models
      this.log.warn(
        cached
          ? `Could not refresh the model list; using ${cached.length} cached models`
          : 'Could not fetch the model list and there is no cache',
        err,
      )
      return cached ?? []
    }
  }

  private async fetchRaw(): Promise<unknown> {
    // /models is public; the key is sent when present (account-specific availability).
    const withKey = this.http.hasKey()
    try {
      return await this.http.json<unknown>('/models', { anonymous: !withKey, timeoutMs: 15_000 })
    } catch (err) {
      // A revoked/invalid key must not hide the public list.
      if (withKey && err instanceof ProviderError && err.code === 'auth') {
        return this.http.json<unknown>('/models', { anonymous: true, timeoutMs: 15_000 })
      }
      throw err
    }
  }

  private loadDiskOnce(): Promise<void> {
    this.diskLoad ??= this.loadDisk()
    return this.diskLoad
  }

  private async loadDisk(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.cacheFile, 'utf8')
    } catch {
      return // no cache yet
    }
    try {
      const parsed = cacheFileSchema.safeParse(JSON.parse(raw))
      if (!parsed.success) {
        this.log.warn('Ignoring invalid model cache file')
        return
      }
      // A network fetch may have finished first; never replace newer data.
      if (this.models === null && parsed.data.models.length > 0) {
        this.setModels(parsed.data.models, parsed.data.fetchedAt)
      }
    } catch (err) {
      this.log.warn('Ignoring corrupt model cache file', err)
    }
  }

  private async saveDisk(data: ModelCacheFile): Promise<void> {
    try {
      await mkdir(dirname(this.cacheFile), { recursive: true })
      // Write-then-rename so a crash never leaves a truncated cache.
      const tmp = `${this.cacheFile}.tmp`
      await writeFile(tmp, JSON.stringify(data), 'utf8')
      await rename(tmp, this.cacheFile)
    } catch (err) {
      this.log.warn('Could not write the model cache', err)
    }
  }
}
