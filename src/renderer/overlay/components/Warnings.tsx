import {
  Check,
  Copy,
  Headphones,
  KeyRound,
  MicOff,
  ShieldCheck,
  TriangleAlert,
  VolumeX,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { CONSENT_DISCLOSURE_MESSAGE } from '@shared/constants'
import { t } from '@shared/i18n'
import type { SessionWarningCode, SettingsPage } from '@shared/types'
import { cn, Spinner } from '../../components/ui'
import { invoke } from '../../lib/ipc'
import { useSettings } from '../../stores/settings'
import { openSettings, reportError } from '../actions'
import { useLive } from '../stores/liveStore'
import { useUi } from '../stores/uiStore'

type Tone = 'info' | 'warning' | 'error'

interface WarningMeta {
  tone: Tone
  icon: LucideIcon | 'spinner'
  action?: {
    label: 'overlay.warnings.addKey' | 'overlay.warnings.openSettings'
    page: SettingsPage
  }
  dismissible?: boolean
}

const META: Record<SessionWarningCode, WarningMeta> = {
  no_key: {
    tone: 'error',
    icon: KeyRound,
    action: { label: 'overlay.warnings.addKey', page: 'models' },
  },
  mic_not_found: {
    tone: 'error',
    icon: MicOff,
    action: { label: 'overlay.warnings.openSettings', page: 'general' },
  },
  mic_denied: {
    tone: 'error',
    icon: MicOff,
    action: { label: 'overlay.warnings.openSettings', page: 'general' },
  },
  loopback_unavailable: { tone: 'error', icon: VolumeX },
  no_system_audio: { tone: 'warning', icon: VolumeX, dismissible: true },
  mic_muted: { tone: 'warning', icon: MicOff },
  stt_error_retrying: { tone: 'warning', icon: 'spinner' },
  use_headphones: { tone: 'info', icon: Headphones, dismissible: true },
}

/** Most important first. */
const ORDER: SessionWarningCode[] = [
  'no_key',
  'mic_denied',
  'mic_not_found',
  'loopback_unavailable',
  'stt_error_retrying',
  'no_system_audio',
  'mic_muted',
  'use_headphones',
]

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
}: {
  tone: Tone
  icon: ReactNode
  children: ReactNode
  trailing?: ReactNode
  code: string
}) {
  return (
    <div
      role={tone === 'info' ? 'status' : 'alert'}
      data-warning={code}
      className={cn(
        'flex min-h-8 animate-fade-in items-center gap-2 rounded-lg border py-1 pr-1 pl-2.5 text-[12.5px] leading-snug text-fg',
        toneClass[tone],
      )}
    >
      <span className={cn('shrink-0', toneIconClass[tone])}>{icon}</span>
      <span className="min-w-0 flex-1">{children}</span>
      {trailing}
    </div>
  )
}

function ConsentReminder() {
  const [copied, setCopied] = useState(false)
  const [hidden, setHidden] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(timer)
  }, [copied])
  if (hidden) return null
  return (
    <div
      role="status"
      data-warning="consent"
      className="animate-fade-in rounded-lg border border-accent/20 bg-accent-soft py-2 pr-1 pl-2.5"
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
            setHidden(true)
            invoke('session:dismissConsent').catch(() => undefined)
          }}
        />
      </div>
    </div>
  )
}

/** Session warnings (no audio, mic problems, STT retrying, missing key, tips) and the consent note. */
export function Warnings() {
  const status = useLive((s) => s.state.status)
  const warnings = useLive((s) => s.state.warnings)
  const showConsent = useLive((s) => s.state.showConsentReminder)
  const lastError = useLive((s) => s.state.lastError)
  const sessionId = useLive((s) => s.state.sessionId)
  const dismissed = useUi((s) => s.dismissedWarnings)

  const active = status === 'starting' || status === 'live'
  if (!active) return null
  const visible = ORDER.filter((c) => warnings.includes(c) && !dismissed.includes(c))
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

  return (
    <div className="flex shrink-0 flex-col gap-1.5 px-3 pt-1 pb-2" data-session={sessionId ?? ''}>
      {visible.map((code) => {
        const meta = META[code]
        const Icon = meta.icon
        return (
          <Row
            key={code}
            code={code}
            tone={meta.tone}
            icon={Icon === 'spinner' ? <Spinner size={14} /> : <Icon size={14} />}
            trailing={
              <>
                {meta.action ? (
                  <button
                    type="button"
                    onClick={() => openSettings(meta.action?.page)}
                    className={cn(smallButton, 'text-accent-text')}
                  >
                    {t(meta.action.label)}
                  </button>
                ) : null}
                {meta.dismissible ? (
                  <DismissButton
                    label={t('overlay.warnings.dismiss')}
                    onClick={() => dismiss(code)}
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
    </div>
  )
}
