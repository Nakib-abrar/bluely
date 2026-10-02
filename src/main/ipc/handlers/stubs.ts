import { notImplemented } from '../../errors'
import { handle, unregisteredChannels } from '../registry'

/**
 * Registers a "not implemented" handler for every contract channel that no feature claimed,
 * so renderers always get a typed error instead of "No handler registered".
 */
export function registerStubHandlers(): string[] {
  const missing = unregisteredChannels()
  for (const channel of missing) {
    handle(channel, () => {
      throw notImplemented(channel)
    })
  }
  return missing
}
