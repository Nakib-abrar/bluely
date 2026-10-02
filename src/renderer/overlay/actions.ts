/**
 * Everything the overlay asks main to do with AI, in one place so buttons, keybinds and
 * global shortcut commands behave identically.
 */
import type { InvokeRequest } from '@shared/ipc'
import { t } from '@shared/i18n'
import type { ActionKind, AiCard, SettingsPage } from '@shared/types'
import { invoke, IpcError } from '../lib/ipc'
import { useSettings } from '../stores/settings'
import { useLive } from './stores/liveStore'
import { useUi, type OverlayTab } from './stores/uiStore'

type RunRequest = InvokeRequest<'ai:run'>

const SETTINGS_FOR_CODE: Partial<Record<string, SettingsPage>> = {
  no_key: 'models',
  auth: 'models',
  model_unavailable: 'models',
}

/** Shows a request failure inline (requests that fail before main creates a card). */
export function reportError(err: unknown): void {
  const ui = useUi.getState()
  if (err instanceof IpcError) {
    const code = err.ai?.code ?? err.code
    if (code === 'aborted') return
    const message =
      err.ai?.message ??
      (code === 'no_key'
        ? t('errors.no_key')
        : code === 'not_implemented'
          ? t('overlay.notice.unavailable')
          : err.message || t('overlay.notice.failed'))
    ui.showNotice(message, SETTINGS_FOR_CODE[code] ?? null)
    return
  }
  ui.showNotice(err instanceof Error && err.message ? err.message : t('overlay.notice.failed'))
}

function activeTier() {
  return useSettings.getState().settings.models.activeTier
}

async function run(req: RunRequest): Promise<void> {
  const ui = useUi.getState()
  ui.clearNotice()
  // The user asked for something: show where the answer will appear.
  selectTab('insights')
  if (!ui.expanded) void setExpanded(true)
  try {
    await invoke('ai:run', req)
  } catch (err) {
    reportError(err)
  }
}

/** ✨ Assist: uses the Assist screen toggle and the active tier. */
export function runAssist(): Promise<void> {
  return run({
    kind: 'assist',
    includeScreen: useUi.getState().screenForAssist,
    tier: activeTier(),
  })
}

/** A typed question: Smart/Fast per the chip, screen per the question toggle. */
export function askQuestion(question: string): Promise<void> {
  const q = question.trim()
  if (!q) return Promise.resolve()
  return run({
    kind: 'ask',
    question: q,
    includeScreen: useUi.getState().screenForQuestions,
    tier: activeTier(),
  })
}

/** Action row / shortcut actions. Tier is omitted so main uses the Fast model. */
export function runAction(kind: ActionKind): Promise<void> {
  if (kind === 'assist') return runAssist()
  return run({ kind })
}

/**
 * The input's primary action: a typed draft is sent as a question (and cleared),
 * an empty input runs Assist.
 */
export function submitDraft(): Promise<void> {
  const ui = useUi.getState()
  const draft = ui.draft.trim()
  if (draft) {
    ui.setDraft('')
    return askQuestion(draft)
  }
  return runAssist()
}

/** Re-runs a failed card with the same kind, question, screen and tier. */
export function retryCard(card: AiCard): Promise<void> {
  useLive.getState().removeCard(card.id)
  switch (card.kind) {
    case 'ask':
      return run({
        kind: 'ask',
        question: card.question ?? card.label,
        includeScreen: card.usedScreen,
        tier: card.tier,
      })
    case 'assist':
      return run({ kind: 'assist', includeScreen: card.usedScreen, tier: card.tier })
    case 'auto':
      // Auto-suggest is a "What should I say?" that main started on its own.
      return run({ kind: 'say' })
    case 'say':
    case 'followups':
    case 'factcheck':
    case 'who':
    case 'recap':
      return run({ kind: card.kind })
    default:
      return Promise.resolve()
  }
}

export function cancelCard(id: string): void {
  invoke('ai:cancel', { id }).catch(reportError)
}

export async function clearChat(): Promise<void> {
  try {
    await invoke('ai:clear')
    // main also broadcasts ai:cleared; clearing here keeps the UI snappy.
    useLive.getState().clearCards()
  } catch (err) {
    reportError(err)
  }
}

/** Switches the panel tab and remembers it for next time. */
export function selectTab(tab: OverlayTab): void {
  const ui = useUi.getState()
  if (ui.tab === tab) return
  ui.setTab(tab)
  useSettings
    .getState()
    .update({ overlay: { tab } })
    .catch(() => undefined)
}

/** Expands or collapses the panel (optimistic; main confirms via overlay:visibility). */
export async function setExpanded(expanded: boolean): Promise<void> {
  useUi.getState().setExpanded(expanded)
  try {
    await invoke('overlay:setExpanded', { expanded })
  } catch {
    // The window keeps its size; the panel still toggles locally.
  }
}

/** "⌄ Hide": hides the whole widget or just collapses the panel, per settings. */
export function hideFromPill(): void {
  if (useSettings.getState().settings.general.hideHidesWidget) {
    invoke('overlay:setVisible', { visible: false }).catch(reportError)
  } else {
    void setExpanded(false)
  }
}

export function stopSession(): void {
  invoke('session:stop').catch(reportError)
}

export function startSession(): void {
  invoke('session:start', {}).catch(reportError)
}

/** The second copy of one keypress (local keydown vs. global command) arrives well within this. */
const ASSIST_DEDUPE_MS = 250
let lastAssistShortcutAt = 0
let lastAssistShortcutSource: 'local' | 'global' | null = null

/**
 * Ctrl+Enter (askAssist). The same keypress can arrive twice: as a local keydown and as
 * the global shortcut's overlay:command. Only the first within a short window counts.
 */
export function assistShortcut(source: 'local' | 'global'): void {
  const now = Date.now()
  if (lastAssistShortcutSource !== source && now - lastAssistShortcutAt < ASSIST_DEDUPE_MS) return
  lastAssistShortcutAt = now
  lastAssistShortcutSource = source
  const ui = useUi.getState()
  if (!ui.expanded) void setExpanded(true)
  ui.requestFocus()
  void submitDraft()
}

export function openSettings(page?: SettingsPage): void {
  invoke('app:openSettings', page ? { page } : {}).catch(reportError)
}

/** Makes `id` the active mode (optimistic: the settings mirror updates immediately). */
export function setActiveMode(id: string): void {
  const before = useSettings.getState().settings
  if (before.activeModeId === id) return
  useSettings.setState({ settings: { ...before, activeModeId: id } })
  invoke('modes:setActive', { id }).catch((err: unknown) => {
    const now = useSettings.getState().settings
    if (now.activeModeId === id) {
      useSettings.setState({ settings: { ...now, activeModeId: before.activeModeId } })
    }
    reportError(err)
  })
}
