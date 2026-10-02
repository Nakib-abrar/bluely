import type { ThemePreference } from '@shared/types'

const media =
  typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null
let currentPref: ThemePreference = 'dark'

function resolve(pref: ThemePreference): 'light' | 'dark' {
  if (pref === 'system') return media?.matches ? 'dark' : 'light'
  return pref
}

/** Applies the theme to <html data-theme>. Call whenever settings change. */
export function applyTheme(pref: ThemePreference): void {
  currentPref = pref
  document.documentElement.dataset['theme'] = resolve(pref)
}

media?.addEventListener('change', () => {
  if (currentPref === 'system') applyTheme('system')
})
