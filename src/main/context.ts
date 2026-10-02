import type { MainWindowRoute } from '@shared/types'
import type { Db } from './db/database'
import type { Env, AppPaths } from './env'
import type { EventBus } from './ipc/events'
import type { Logger } from './log'
import type { SecretStore } from './settings/secrets'
import type { SettingsStore } from './settings/settingsStore'
import type { WindowRegistry } from './windows/registry'
import type { OverlayController } from './windows/overlayWindow'

/** Core services available to every feature module's wiring function. */
export interface CoreContext {
  env: Env
  paths: AppPaths
  log: Logger
  db: Db
  settings: SettingsStore
  secrets: SecretStore
  events: EventBus
  windows: WindowRegistry
  overlay: OverlayController
  /** Opens/focuses the main window, optionally navigating. */
  showMainWindow: (route?: MainWindowRoute) => void
}
