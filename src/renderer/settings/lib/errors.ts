import { t } from '@shared/i18n'
import { errors as providerErrors } from '@shared/i18n/en/errors'
import { IpcError } from '../../lib/ipc'

type ProviderErrorKey = keyof typeof providerErrors

function isProviderErrorKey(code: string): code is ProviderErrorKey {
  return Object.prototype.hasOwnProperty.call(providerErrors, code)
}

/**
 * Turns anything thrown by IPC or Web Audio into one friendly sentence for the settings UI.
 * Provider errors already carry a friendly message from main; media errors are explained here.
 */
export function describeError(err: unknown): string {
  if (err instanceof IpcError) {
    if (err.ai?.message) return err.ai.message
    if (err.code === 'not_implemented') return t('settings.notAvailable')
    if (isProviderErrorKey(err.code)) return t(`errors.${err.code}`)
    return err.message || t('errors.unknown')
  }
  if (err instanceof DOMException) {
    switch (err.name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return t('settings.audio.mic.denied')
      case 'NotFoundError':
        return t('settings.audio.mic.notFound')
      case 'NotReadableError':
      case 'AbortError':
        return t('settings.audio.mic.busy')
      case 'OverconstrainedError':
        return t('settings.audio.mic.gone')
      default:
        return err.message || t('errors.unknown')
    }
  }
  if (err instanceof Error && err.name === 'OverconstrainedError')
    return t('settings.audio.mic.gone')
  if (err instanceof Error) return err.message || t('errors.unknown')
  return t('errors.unknown')
}

/** True for a user-initiated cancel (AbortController), which should not be shown as an error. */
export function isAbort(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === 'AbortError') ||
    (err instanceof Error && err.name === 'AbortError')
  )
}

/** True when main has no handler for a channel yet (shown quietly, not as a red error). */
export function isNotImplemented(err: unknown): boolean {
  return err instanceof IpcError && err.code === 'not_implemented'
}
