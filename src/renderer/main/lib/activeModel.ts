import type { Settings } from '@shared/settings'
import type { Mode } from '@shared/types'

/** The Mode main answers with: the active one, else General, else the first (AiService.activeMode). */
export function activeMode(modes: readonly Mode[], activeModeId: string): Mode | undefined {
  return (
    modes.find((m) => m.id === activeModeId) ??
    modes.find((m) => m.id === 'builtin-general') ??
    modes[0]
  )
}

/**
 * The model that answers typed questions and Assist right now, resolved the way main does
 * (AiService.resolveModel): the overlay's Fast/Smart tier, then the active Mode's override for
 * that tier, else the model set for the tier in Settings.
 */
export function answeringModel(models: Settings['models'], mode: Mode | undefined): string {
  const tier = models.activeTier
  return mode?.modelOverrides[tier] || models[tier].model
}
