import { create } from 'zustand'
import type { SessionWarningCode, SettingsPage } from '@shared/types'
import { useSettings } from '../../stores/settings'

export type OverlayTab = 'insights' | 'transcript'

/** A short-lived inline message (e.g. a request that failed before it produced a card). */
export interface OverlayNotice {
  id: number
  message: string
  /** When set, the notice offers a button that opens this Settings page. */
  settingsPage: SettingsPage | null
}

export interface UiStore {
  expanded: boolean
  tab: OverlayTab
  devOpen: boolean
  /** Draft question. Lives here so it survives collapsing the panel. */
  draft: string
  /**
   * Epoch ms of the latest request for the input to take focus. A timestamp (not a counter)
   * so an input that mounts later only honours a request made just before it appeared.
   */
  focusRequest: number
  /** Include-screen toggles: one for Assist (empty input), one for typed questions. */
  screenForAssist: boolean
  screenForQuestions: boolean
  /** Answers that arrived while the Transcript tab was showing. */
  unseen: number
  notice: OverlayNotice | null
  /** Warnings the user closed during this session (main may keep reporting them). */
  dismissedWarnings: SessionWarningCode[]

  setExpanded(expanded: boolean): void
  setTab(tab: OverlayTab): void
  toggleDev(): void
  setDraft(draft: string): void
  requestFocus(): void
  toggleScreen(target: 'assist' | 'question'): void
  noteNewCard(): void
  showNotice(message: string, settingsPage?: SettingsPage | null): void
  clearNotice(id?: number): void
  dismissWarning(code: SessionWarningCode): void
  resetSessionUi(): void
}

let noticeSeq = 0

export const useUi = create<UiStore>((set, get) => ({
  expanded: true,
  tab: 'insights',
  devOpen: false,
  draft: '',
  focusRequest: 0,
  screenForAssist: true,
  screenForQuestions: false,
  unseen: 0,
  notice: null,
  dismissedWarnings: [],

  setExpanded: (expanded) => set({ expanded }),
  setTab: (tab) => set(tab === 'insights' ? { tab, unseen: 0 } : { tab }),
  toggleDev: () => set({ devOpen: !get().devOpen }),
  setDraft: (draft) => set({ draft }),
  requestFocus: () => set({ focusRequest: Math.max(Date.now(), get().focusRequest + 1) }),
  toggleScreen: (target) =>
    set(
      target === 'assist'
        ? { screenForAssist: !get().screenForAssist }
        : { screenForQuestions: !get().screenForQuestions },
    ),
  noteNewCard: () => {
    if (get().tab !== 'insights') set({ unseen: get().unseen + 1 })
  },
  showNotice: (message, settingsPage = null) =>
    set({ notice: { id: ++noticeSeq, message, settingsPage } }),
  clearNotice: (id) => {
    const current = get().notice
    if (current && (id == null || current.id === id)) set({ notice: null })
  },
  dismissWarning: (code) => {
    if (!get().dismissedWarnings.includes(code)) {
      set({ dismissedWarnings: [...get().dismissedWarnings, code] })
    }
  },
  resetSessionUi: () => set({ dismissedWarnings: [], unseen: 0, notice: null }),
}))

/** Restores the panel's expanded state and tab from settings (call once before first render). */
export function hydrateUiFromSettings(): void {
  const { expanded, tab } = useSettings.getState().settings.overlay
  useUi.setState({ expanded, tab })
}
