import { useEffect } from 'react'
import type { Mode } from '@shared/types'
import { useSettings } from '../../stores/settings'
import { useModes } from '../stores/modesStore'

/** Modes list plus the active one (falls back to the first mode for an unknown id). */
export function useActiveMode(): { modes: Mode[]; active: Mode | undefined; activeId: string } {
  const modes = useModes((s) => s.modes)
  const activeId = useSettings((s) => s.settings.activeModeId)
  useEffect(() => useModes.getState().ensureLoaded(), [])
  return { modes, active: modes.find((m) => m.id === activeId) ?? modes[0], activeId }
}
