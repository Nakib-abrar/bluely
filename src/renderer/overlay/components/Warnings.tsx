import {
  Check,
  Copy,
  Headphones,
  KeyRound,
  MicOff,
  RotateCw,
  ShieldCheck,
  TriangleAlert,
  VolumeX,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { CONSENT_DISCLOSURE_MESSAGE } from '@shared/constants'
import { t } from '@shared/i18n'
import type { Channel, ChannelStatus, SessionWarningCode, SettingsPage } from '@shared/types'
import { cn, Spinner } from '../../components/ui'
import { failureWarning } from '../../audio/captureController'
import { invoke } from '../../lib/ipc'
import { useSettings } from '../../stores/settings'
import { openSettings, reportError } from '../actions'
import { retryCapture } from '../hooks/useCapture'
import { useLive } from '../stores/liveStore'
import { useUi } from '../stores/uiStore'

type Tone = 'info' | 'warning' | 'error'

/**
 * Rows the overlay shows: main's session warnings, plus a generic row per channel for
 * capture failures no specific warning explains (e.g. voice detection failed to load).
 */
type RowCode = SessionWarningCode | 'mic_failed' | 'system_audio_failed'

type RowAction =
  | {
      kind: 'settings'
      label: 'overlay.warnings.addKey' | 'overlay.warnings.audioSettings'
      page: SettingsPage
    }
  /** Re-open the channel (e.g. after the user allowed microphone access in Windows). */
  | { kind: 'retry'; channel: Channel }

interface WarningMeta {
  tone: Tone
  icon: LucideIcon | 'spinner'
  action?: RowAction
  dismissible?: boolean
}

const META: Record<RowCode, WarningMeta> = {
  no_key: {
    tone: 'error',
    icon: KeyRound,
    action: { kind: 'settings', label: 'overlay.warnings.addKey', page: 'models' },
  },
  mic_denied: { tone: 'error', icon: MicOff, action: { kind: 'retry', channel: 'me' } },
  mic_not_found: {
    tone: 'error',
    icon: MicOff,
    // Settings › General › Audio: picking another mic there switches it mid-call.
    action: { kind: 'settings', label: 'overlay.warnings.audioSettings', page: 'general' },
  },
  mic_failed: { tone: 'error', icon: MicOff, action: { kind: 'retry', channel: 'me' } },
  loopback_unavailable: { tone: 'error', icon: VolumeX },
  system_audio_failed: { tone: 'error', icon: VolumeX, action: { kind: 'retry', channel: 'them' } },
  no_system_audio: { tone: 'warning', icon: VolumeX, dismissible: true },
  mic_muted: { tone: 'warning', icon: MicOff },
  stt_error_retrying: { tone: 'warning', icon: 'spinner' },
  use_headphones: { tone: 'info', icon: Headphones, dismissible: true },
}

/** Most important first. */
const ORDER: RowCode[] = [
  'no_key',
  'mic_denied',
  'mic_not_found',
  'mic_failed',
  'loopback_unavailable',
  'system_audio_failed',
  'stt_error_retrying',
  'no_system_audio',
  'mic_muted',
  'use_headphones',
]

/** The warnings that already explain a failed channel. */
const CHANNEL_WARNINGS: Record<Channel, SessionWarningCode[]> = {
  me: ['mic_not_found', 'mic_denied'],
  them: ['loopback_unavailable'],
}

/**
 * True when a channel failed for a reason no warning explains. A failure whose code maps to
 * a warning never shows the generic row, even before that warning arrives.
 */
function failedWithoutWarning(
  channel: Channel,
  status: ChannelStatus,
  shown: readonly SessionWarningCode[],
): boolean {
  if (status.state !== 'error') return false
  if (failureWarning(channel, status.code) !== null) return false
  return !CHANNEL_WARNINGS[channel].some((code) => shown.includes(code))
}

/** Tooltip for a generic failure row: the channel's error text, if any, as details. */
function detailsTitle(error: string | null | undefined): string | undefined {
  return error ? t('overlay.warnings.details', { error }) : undefined
}

const toneClass: Record<Tone, string> = {
  info: 'border-accent/20 bg-accent-soft',
  warning: 'border-warning/25 bg-warning-soft',
  error: 'border-danger/25 bg-danger-soft',
}
const toneIconClass: Record<Tone, string> = {
  info: 'text-accent-text',
  warning: 'text-warning',
  error: 'text-danger',
}

const smallButton =
  'no-drag inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-[12px] font-semibold transition-colors duration-150 hover:bg-panel-3'

function DismissButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="no-drag inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted transition-colors duration-150 hover:bg-panel-3 hover:text-fg"
    >
      <X size={13} />
    </button>
  )
}

function Row({
  tone,
  icon,
  children,
  trailing,
  code,
  title,
}: {
  tone: Tone
  icon: ReactNode
  children: ReactNode
  trailing?: ReactNode
  code: string
  title?: string
}) {
  return (
    <div
      // Only errors interrupt a screen reader; warnings that come and go (STT retrying, no
      // system audio, muted mic) and tips are announced politely.
      role={tone === 'error' ? 'alert' : 'status'}
      data-warning={code}
      title={title}
      className={cn(
        'flex min-h-8 shrink-0 animate-fade-in items-center gap-2 rounded-lg border py-1 pr-1 pl-2.5 text-[12.5px] leading-snug text-fg',
        toneClass[tone],
      )}
    >
      <span className={cn('shrink-0', toneIconClass[tone])}>{icon}</span>
      <span className="min-w-0 flex-1">{children}</span>
      {trailing}
    </div>
  )
}

function ActionButton({ action }: { action: RowAction }) {
  if (action.kind === 'retry') {
    return (
      <button
        type="button"
        onClick={() => retryCapture(action.channel)}
        className={cn(smallButton, 'text-accent-text')}
      >
        <RotateCw size={12} />
        {t('overlay.warnings.retry')}
      </button>
    )
  }
  return (
    <button
      type="button"
      onClick={() => openSettings(action.page)}
      className={cn(smallButton, 'text-accent-text')}
    >
      {t(action.label)}
    </button>
  )
}

function ConsentReminder() {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <div
      role="status"
      data-warning="consent"
      className="shrink-0 animate-fade-in rounded-lg border border-accent/20 bg-accent-soft py-2 pr-1 pl-2.5"
    >
      <div className="flex items-start gap-2">
        <ShieldCheck size={15} className="mt-px shrink-0 text-accent-text" />
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] leading-snug font-medium text-fg">
            {t('overlay.consent.title')}
          </div>
          <button
            type="button"
            onClick={() => {
              invoke('clipboard:writeText', { text: CONSENT_DISCLOSURE_MESSAGE })
                .then(() => setCopied(true))
                .catch(reportError)
            }}
            className={cn(smallButton, '-ml-2 mt-0.5 text-accent-text')}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
            {copied ? t('overlay.consent.copied') : t('overlay.consent.copy')}
          </button>
        </div>
        <DismissButton
          label={t('overlay.consent.dismiss')}
          onClick={() => {
            useUi.getState().dismissConsent()
            invoke('session:dismissConsent').catch(() => undefined)
          }}
        />
      </div>
    </div>
  )
}

/**
 * Session warnings (no audio, mic problems, STT retrying, missing key, tips) and the consent
 * note. `panel` sits inside the expanded panel above the lists; `strip` is the compact card
 * under the pill while the panel is collapsed, so the consent reminder and problems are
 * never hidden just because the user collapsed the panel in an earlier call.
 */
export function Warnings({ variant = 'panel' }: { variant?: 'panel' | 'strip' }) {
  const status = useLive((s) => s.state.status)
  const warnings = useLive((s) => s.shownWarnings)
  const audio = useLive((s) => s.state.audio)
  const consentPending = useLive((s) => s.state.showConsentReminder)
  const lastError = useLive((s) => s.state.lastError)
  const sessionId = useLive((s) => s.state.sessionId)
  const dismissed = useUi((s) => s.dismissedWarnings)
  const consentDismissed = useUi((s) => s.consentDismissed)
  const showConsent = consentPending && !consentDismissed

  const active = status === 'starting' || status === 'live'
  if (!active) return null
  const failed: Partial<Record<RowCode, ChannelStatus>> = {}
  if (failedWithoutWarning('me', audio.me, warnings)) failed.mic_failed = audio.me
  if (failedWithoutWarning('them', audio.them, warnings)) failed.system_audio_failed = audio.them
  const visible = ORDER.filter(
    (c) =>
      failed[c] !== undefined ||
      (warnings.includes(c as SessionWarningCode) && !dismissed.includes(c as SessionWarningCode)),
  )
  if (!visible.length && !showConsent && !lastError) return null

  const dismiss = (code: SessionWarningCode) => {
    useUi.getState().dismissWarning(code)
    if (code === 'use_headphones') {
      // One-time tip: never show it again.
      useSettings
        .getState()
        .update({ general: { headphonesTipShown: true } })
        .catch(() => undefined)
    }
  }

  const rows = (
    <>
      {visible.map((code) => {
        const meta = META[code]
        const Icon = meta.icon
        return (
          <Row
            key={code}
            code={code}
            tone={meta.tone}
            // The raw channel error (from the browser or the voice detector) is diagnostic
            // detail, behind a translated label.
            title={detailsTitle(failed[code]?.error)}
            icon={Icon === 'spinner' ? <Spinner size={14} /> : <Icon size={14} />}
            trailing={
              <>
                {meta.action ? <ActionButton action={meta.action} /> : null}
                {meta.dismissible ? (
                  <DismissButton
                    label={t('overlay.warnings.dismiss')}
                    onClick={() => dismiss(code as SessionWarningCode)}
                  />
                ) : null}
              </>
            }
          >
            {t(`overlay.warnings.${code}`)}
          </Row>
        )
      })}
      {lastError && !visible.length ? (
        <Row code="last_error" tone="error" icon={<TriangleAlert size={14} />}>
          {lastError}
        </Row>
      ) : null}
      {showConsent ? <ConsentReminder key={sessionId ?? 'none'} /> : null}
    </>
  )

  if (variant === 'strip') {
    return (
      <section
        data-hit
        data-warnings="strip"
        aria-label={t('overlay.warnings.label')}
        className="ov-panel-in mt-2 flex max-h-[232px] w-full flex-col gap-1.5 overflow-y-auto rounded-2xl border border-ov-line bg-ov-panel p-2 shadow-panel"
      >
        {rows}
      </section>
    )
  }
  // Capped and scrollable: a pile of warnings must never squeeze the answers to nothing or
  // spill over the input below.
  return (
    <div
      data-warnings="panel"
      data-session={sessionId ?? ''}
      className="flex max-h-[40%] shrink-0 flex-col gap-1.5 overflow-y-auto px-3 pt-1 pb-2"
    >
      {rows}
    </div>
  )
}
