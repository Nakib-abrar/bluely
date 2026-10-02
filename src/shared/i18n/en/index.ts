import { actions } from './actions'
import { common } from './common'
import { errors } from './errors'
import { home } from './home'
import { keybinds } from './keybinds'
import { onboarding } from './onboarding'
import { overlay } from './overlay'
import { session } from './session'
import { settings } from './settings'

export const en = {
  common,
  actions,
  keybinds,
  errors,
  home,
  session,
  onboarding,
  settings,
  overlay,
} as const
