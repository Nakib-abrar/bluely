import type { CoreContext } from '../context'
import { handle } from '../ipc/registry'
import type { OpenRouterHttp } from '../providers/openrouterHttp'
import { OpenRouterSTT } from '../providers/stt/openrouterStt'
import {
  TranscriptionQueue,
  type TranscriptionQueueOptions,
} from '../providers/stt/transcriptionQueue'
import { runTestTranscription, sttOptionsFromSettings } from './testTranscribe'
import { createSttUsageRecorder } from './usage'

/**
 * Options for SttFeature.createQueue. Same as TranscriptionQueueOptions minus the provider
 * and logger; `getOptions` defaults to the current STT model + transcription language and
 * `concurrencyPerChannel` to settings.advanced.sttConcurrency.
 */
export type SttQueueOptions = Omit<
  TranscriptionQueueOptions,
  'stt' | 'log' | 'getOptions' | 'concurrencyPerChannel'
> &
  Partial<Pick<TranscriptionQueueOptions, 'getOptions' | 'concurrencyPerChannel'>>

export interface SttFeature {
  stt: OpenRouterSTT
  /**
   * A queue for one live session. Every billed request is written to usage_log (kind 'stt',
   * with the job's sessionId) before `opts.onUsage` runs.
   */
  createQueue(opts: SttQueueOptions): TranscriptionQueue
}

/** Wires speech-to-text: the OpenRouter provider, the mic-test IPC handler and queue factory. */
export function wireStt(ctx: CoreContext, deps: { http: OpenRouterHttp }): SttFeature {
  const log = ctx.log.child('stt')
  const stt = new OpenRouterSTT({ http: deps.http, log })
  const recordUsage = createSttUsageRecorder(ctx.db, log)

  handle('audio:testTranscribe', ({ wav }) =>
    runTestTranscription(
      {
        stt,
        getSettings: () => ctx.settings.get(),
        recordUsage: (result) => recordUsage(result, null),
      },
      wav,
    ),
  )

  return {
    stt,
    createQueue: (opts) =>
      new TranscriptionQueue({
        ...opts,
        stt,
        log: log.child('queue'),
        getOptions: opts.getOptions ?? (() => sttOptionsFromSettings(ctx.settings.get())),
        concurrencyPerChannel:
          opts.concurrencyPerChannel ?? ctx.settings.get().advanced.sttConcurrency,
        onUsage: (job, result) => {
          recordUsage(result, job.sessionId)
          opts.onUsage?.(job, result)
        },
      }),
  }
}
