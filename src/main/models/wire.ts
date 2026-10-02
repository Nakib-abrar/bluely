import { join } from 'node:path'
import type { Settings } from '@shared/settings'
import type { ModelValidationResult, RoleConfig } from '@shared/types'
import type { CoreContext } from '../context'
import { handle } from '../ipc/registry'
import type { ProviderRouting } from '../providers/llm/LLMProvider'
import { OpenRouterLLM, type ChatFinishedInfo } from '../providers/llm/openrouter'
import { OpenRouterHttp, type FetchLike } from '../providers/openrouterHttp'
import { ModelCatalog } from './catalog'
import { testKey } from './keyInfo'
import { LATENCY_TEST_TAG, LatencyTester } from './latency'
import { ModelStatsRepo } from './statsRepo'
import { validateDefaults } from './validate'

/** Services of the models feature that other features use. */
export interface ModelsFeature {
  /** The one keep-alive OpenRouter HTTP layer (share it with the STT provider). */
  http: OpenRouterHttp
  llm: OpenRouterLLM
  catalog: ModelCatalog
  stats: ModelStatsRepo
  latency: LatencyTester
  /** Results of the most recent default-model validation ([] until the first one ran). */
  lastValidation(): ModelValidationResult[]
  /** Called after every validation run (startup and 'models:validateDefaults'). */
  onValidation(cb: (r: ModelValidationResult[]) => void): () => void
  /** Stops timers and the latency test, closes the HTTP agent. Call once on quit. */
  dispose(): Promise<void>
}

export interface WireModelsOptions {
  /** Delay before the background catalog refresh + validation (default 1500 ms). */
  startupDelayMs?: number
  /** Test seam for the HTTP layer. */
  fetchImpl?: FetchLike
}

/** Provider routing for a role's settings (empty `order` omitted). */
export function routingFor(
  roleConfig: Pick<RoleConfig, 'sort' | 'order' | 'allowFallbacks'>,
): ProviderRouting {
  return {
    sort: roleConfig.sort,
    ...(roleConfig.order.length > 0 ? { order: [...roleConfig.order] } : {}),
    allowFallbacks: roleConfig.allowFallbacks,
  }
}

/** Routing of the first chat role using `model`; latency-sorted with fallbacks otherwise. */
export function routingForModel(settings: Settings, model: string): ProviderRouting {
  for (const role of ['fast', 'smart', 'notes'] as const) {
    const rc = settings.models[role]
    if (rc.model === model) return routingFor(rc)
  }
  return { sort: 'latency', allowFallbacks: true }
}

/**
 * Wires OpenRouter chat, the model catalog, latency stats/tests, spend and key testing.
 * Registers: models:list, models:validateDefaults, models:runLatencyTest, models:getStats,
 * usage:getMonthSpend, key:test. Refreshes the catalog and validates the configured models in
 * the background shortly after startup (never blocking startup).
 */
export function wireModels(ctx: CoreContext, opts: WireModelsOptions = {}): ModelsFeature {
  const log = ctx.log.child('models')
  const http = new OpenRouterHttp({
    baseUrl: ctx.env.openRouterBaseUrl,
    getKey: () => ctx.secrets.getKey(),
    log: log.child('http'),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  })
  const stats = new ModelStatsRepo(ctx.db)
  const catalog = new ModelCatalog({
    http,
    log,
    cacheFile: join(ctx.paths.userData, 'models-cache.json'),
  })

  // Every finished chat request is logged for "spend this month" and feeds the rolling
  // per-model latency averages (latency tests record their own samples).
  const onFinished = (info: ChatFinishedInfo) => {
    const s = info.stats
    try {
      stats.logUsage({
        kind: 'llm',
        model: s.model,
        provider: s.provider,
        costUsd: s.costUsd,
        tokensIn: s.tokensIn,
        tokensOut: s.tokensOut,
      })
      if (info.request.tag !== LATENCY_TEST_TAG) {
        stats.recordSample({
          model: info.request.model,
          provider: s.provider,
          ttftMs: s.ttftMs,
          totalMs: s.totalMs,
          tokensPerSec: s.tokensPerSec,
        })
      }
    } catch (err) {
      log.warn('Could not record LLM usage', err)
    }
  }

  const llm = new OpenRouterLLM({ http, log: log.child('llm'), catalog, onFinished })
  const latency = new LatencyTester({
    llm,
    stats,
    events: ctx.events,
    log: log.child('latency'),
    getRouting: (model) => routingForModel(ctx.settings.get(), model),
  })

  let last: ModelValidationResult[] = []
  const subscribers = new Set<(r: ModelValidationResult[]) => void>()

  const runValidation = async (refresh: boolean): Promise<ModelValidationResult[]> => {
    const models = await catalog.list({ refresh })
    const { results, patch } = validateDefaults(ctx.settings.get(), models)
    if (patch) {
      try {
        ctx.settings.update(patch)
      } catch (err) {
        log.error('Could not apply model replacements', err)
      }
    }
    for (const r of results) if (r.reason) log.info(r.reason)
    last = results
    for (const cb of subscribers) {
      try {
        cb(results)
      } catch (err) {
        log.warn('Validation subscriber failed', err)
      }
    }
    return results
  }

  handle('models:list', ({ refresh }) => catalog.list({ refresh: refresh ?? false }))
  handle('models:validateDefaults', () => runValidation(false))
  handle('models:runLatencyTest', ({ models, runs }) => ({ runId: latency.start(models, runs) }))
  handle('models:getStats', () => stats.list())
  handle('usage:getMonthSpend', () => stats.monthSpend(Date.now()))
  handle('key:test', () => testKey(http))

  const startupTimer = setTimeout(() => {
    runValidation(true).catch((err: unknown) => log.warn('Startup model validation failed', err))
  }, opts.startupDelayMs ?? 1500)

  return {
    http,
    llm,
    catalog,
    stats,
    latency,
    lastValidation: () => last,
    onValidation: (cb) => {
      subscribers.add(cb)
      return () => {
        subscribers.delete(cb)
      }
    },
    dispose: async () => {
      clearTimeout(startupTimer)
      latency.cancel()
      await latency.whenIdle()
      await http.close()
    },
  }
}
