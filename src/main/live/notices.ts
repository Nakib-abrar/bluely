import { t } from '@shared/i18n'
import { KEYBIND_DEFS, keybindDisplay, type KeybindId } from '@shared/keybinds'
import type { KeybindStatus, ModelValidationResult, Notice, UpdateStatus } from '@shared/types'
import type { CoreContext } from '../context'
import type { HistoryFeature } from '../history/wire'

const GLOBAL_KEYBINDS = new Set<string>(
  KEYBIND_DEFS.filter((d) => d.scope === 'global').map((d) => d.id),
)

/** A global shortcut another app already holds (older statuses carry only the error text). */
function isTaken(s: KeybindStatus): boolean {
  if (s.registered || !GLOBAL_KEYBINDS.has(s.id) || !s.accelerator) return false
  if (s.reason != null) return s.reason === 'taken'
  return s.error === t('keybinds.taken')
}

/**
 * Aggregates the main-window banners: missing key, shortcuts taken by another app, replaced
 * default models, recovered sessions and updates. Dismissals persist in
 * settings.general.dismissedNotices.
 */
export class NoticeCenter {
  private modelNotices: Notice[] = []
  private updateNotice: Notice | null = null
  private takenKeybinds: KeybindStatus[] = []

  constructor(
    private readonly ctx: CoreContext,
    private readonly history: HistoryFeature,
  ) {
    ctx.settings.onChange((next, prev) => {
      if (next.general.dismissedNotices !== prev.general.dismissedNotices) this.publish()
    })
    ctx.events.subscribe('sessions:changed', () => this.publish())
    ctx.events.subscribe('keybinds:status', (statuses) => this.setKeybindStatus(statuses))
  }

  list(): Notice[] {
    const dismissed = new Set(this.ctx.settings.get().general.dismissedNotices)
    const notices: Notice[] = []
    if (!this.ctx.secrets.getKey() && this.ctx.settings.get().general.onboardingComplete) {
      notices.push({
        id: 'no-key',
        kind: 'warning',
        title: t('live.notices.noKeyTitle'),
        body: t('live.notices.noKeyBody'),
        action: {
          label: t('live.notices.noKeyAction'),
          action: { type: 'openSettings', page: 'models' },
        },
        dismissible: false,
      })
    }
    if (this.takenKeybinds.length) notices.push(this.keybindsNotice(this.takenKeybinds))
    if (this.updateNotice) notices.push(this.updateNotice)
    notices.push(...this.modelNotices)
    for (const s of this.history.sessions.list({ limit: 50 })) {
      if (s.status !== 'recovered') continue
      notices.push({
        id: `recovered-${s.id}`,
        kind: 'warning',
        title: t('live.notices.recoveredTitle'),
        body: t('live.notices.recoveredBody', {
          title: s.title || 'Untitled session',
          date: new Date(s.startedAt).toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
          }),
        }),
        action: {
          label: t('live.notices.recoveredAction'),
          action: { type: 'regenerateSession', sessionId: s.id },
        },
        dismissible: true,
      })
    }
    return notices.filter((n) => !n.dismissible || !dismissed.has(n.id))
  }

  dismiss(id: string): void {
    const s = this.ctx.settings.get()
    if (s.general.dismissedNotices.includes(id)) return
    this.ctx.settings.update({
      general: { dismissedNotices: [...s.general.dismissedNotices, id].slice(-200) },
    })
  }

  setModelValidation(results: ModelValidationResult[]): void {
    this.modelNotices = results
      .filter((r) => r.replaced)
      .map((r) => ({
        id: `model-${r.role}-${r.resolved}`,
        kind: 'info' as const,
        title: t('live.notices.modelFallbackTitle'),
        body: r.reason,
        action: {
          label: t('live.notices.modelAction'),
          action: { type: 'openSettings' as const, page: 'models' as const },
        },
        dismissible: true,
      }))
    this.publish()
  }

  /**
   * Spec 9.4: warn when a global shortcut is taken by another app. Settings › Keybinds marks the
   * row, but nobody looks there when a shortcut silently does nothing, so it is also a banner.
   */
  setKeybindStatus(statuses: KeybindStatus[]): void {
    const taken = statuses.filter(isTaken)
    const key = (list: KeybindStatus[]) => list.map((s) => `${s.id}:${s.accelerator}`).join('|')
    if (key(taken) === key(this.takenKeybinds)) return
    this.takenKeybinds = taken
    this.publish()
  }

  setUpdateStatus(status: UpdateStatus): void {
    if (status.state === 'available' && status.version) {
      this.updateNotice = {
        id: `update-available-${status.version}`,
        kind: 'info',
        title: t('live.notices.updateAvailableTitle', { version: status.version }),
        body: null,
        action: {
          label: t('live.notices.updateAvailableAction'),
          action: { type: 'openSettings', page: 'general' },
        },
        dismissible: true,
      }
    } else if (status.state === 'downloaded' && status.version) {
      this.updateNotice = {
        id: `update-ready-${status.version}`,
        kind: 'success',
        title: t('live.notices.updateReadyTitle', { version: status.version }),
        body: t('live.notices.updateReadyBody'),
        action: { label: t('live.notices.updateReadyAction'), action: { type: 'installUpdate' } },
        dismissible: true,
      }
    } else {
      this.updateNotice = null
    }
    this.publish()
  }

  private keybindsNotice(taken: KeybindStatus[]): Notice {
    const keys = taken.map((s) => keybindDisplay(s.id as KeybindId, s.accelerator).join('+'))
    return {
      // A different set of taken shortcuts shows again even after an earlier banner was dismissed.
      id: `keybinds-taken-${taken
        .map((s) => s.accelerator)
        .sort()
        .join(',')}`,
      kind: 'warning',
      title: t('live.notices.keybindsTakenTitle'),
      body: t('live.notices.keybindsTakenBody', { keys: keys.join(', ') }),
      action: {
        label: t('live.notices.keybindsTakenAction'),
        action: { type: 'openSettings', page: 'keybinds' },
      },
      dismissible: true,
    }
  }

  publish(): void {
    this.ctx.events.broadcast('app:notices', this.list())
  }
}
