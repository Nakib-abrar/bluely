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

/** Longest typed question main accepts (the 'ai:run' contract in src/shared/ipc.ts). */
export const MAX_QUESTION_CHARS = 4000

/** Opens the panel on Insights, where answers appear. */
export function showAnswers(): void {
  selectTab('insights')
  if (!useUi.getState().expanded) void setExpanded(true)
}

/** Shows a friendly notice and returns true when a question is over the length limit. */
function refuseTooLong(question: string): boolean {
  if (question.length <= MAX_QUESTION_CHARS) return false
  useUi.getState().showNotice(
    t('overlay.notice.tooLong', {
      count: question.length.toLocaleString(),
      max: MAX_QUESTION_CHARS.toLocaleString(),
    }),
  )
  return true
}

/** Sends a request; resolves false (after showing why) when main refused it. */
async function request(req: RunRequest): Promise<boolean> {
  useUi.getState().clearNotice()
  // The user asked for something: show where the answer will appear.
  showAnswers()
  try {
    await invoke('ai:run', req)
    return true
  } catch (err) {
    reportError(err)
    return false
  }
}

async function run(req: RunRequest): Promise<void> {
  await request(req)
}

/** ✨ Assist: uses the Assist screen toggle and the active tier. */
export function runAssist(): Promise<void> {
  return run({
    kind: 'assist',
    includeScreen: useUi.getState().screenForAssist,
    tier: activeTier(),
  })
}

/**
 * A typed question: Smart/Fast per the chip, screen per the question toggle. Resolves true
 * once main accepted it; a question over the length limit is refused here with a notice.
 */
export async function askQuestion(question: string): Promise<boolean> {
  const q = question.trim()
  if (!q || refuseTooLong(q)) return false
  return request({
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
 * Sends the typed draft as a question. The input clears at once; if the question can't be
 * sent (too long, main refused it) the draft comes back so nothing the user typed or pasted
 * is lost.
 */
export async function sendDraft(): Promise<void> {
  const ui = useUi.getState()
  const draft = ui.draft
  const question = draft.trim()
  // Too long: say so and keep the draft so the user can shorten it.
  if (!question || refuseTooLong(question)) return
  ui.setDraft('')
  const sent = await askQuestion(draft)
  // Don't overwrite something new the user started typing meanwhile.
  if (!sent && useUi.getState().draft === '') useUi.getState().setDraft(draft)
}

/**
 * The input's primary action: a typed draft is sent as a question (and cleared),
 * an empty input runs Assist.
 */
export function submitDraft(): Promise<void> {
  if (useUi.getState().draft.trim()) return sendDraft()
  return runAssist()
}

/**
 * A live answer card arrived from main. Answers the user asked for (buttons, keybinds, and
 * the global Ctrl+Shift+1/2/3 shortcuts that main runs directly) must be visible, so the
 * panel opens on Insights. Auto-suggestions never pop the panel open; they count as unseen.
 */
export function receiveLiveCard(card: AiCard): void {
  if (card.scope !== 'live') return
  const live = useLive.getState()
  const isNew = !live.cards.some((c) => c.id === card.id)
  live.upsertCard(card)
  // Not new, or for another session (dropped by the store).
  if (!isNew || !useLive.getState().cards.some((c) => c.id === card.id)) return
  if (card.kind === 'auto') useUi.getState().noteNewCard()
  else showAnswers()
}

/**
 * Meetings changed in History (`id` null = many at once: Delete all, retention). If the
 * meeting whose transcript and answers the overlay still shows no longer exists, drop them
 * so a deleted call never reappears on the next Show overlay.
 */
export async function forgetIfDeleted(id: string | null): Promise<void> {
  const kept = useLive.getState().sessionId
  if (!kept || (id !== null && id !== kept)) return
  try {
    // A rename or new notes also say "changed": only a missing meeting was deleted.
    const detail = await invoke('sessions:get', { id: kept })
    if (detail === null) useLive.getState().forget(kept)
  } catch {
    // Can't tell; keep what the overlay shows.
  }
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
