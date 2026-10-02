import { ChevronDown, ChevronUp, Play, Square } from 'lucide-react'
import type { ReactNode } from 'react'
import { t } from '@shared/i18n'
import type { LiveStatus } from '@shared/types'
import { cn, LogoMark, Spinner, Tooltip } from '../../components/ui'
import { formatElapsed } from '../../lib/format'
import { useSettings } from '../../stores/settings'
import { hideFromPill, setExpanded, startSession, stopSession } from '../actions'
import type { CaptureLike } from '../capture'
import { useElapsed } from '../hooks/useElapsed'
import { useLive } from '../stores/liveStore'
import { useUi } from '../stores/uiStore'
import { ActivityMeter } from './ActivityMeter'

const pillButton =
  'no-drag inline-flex h-8 items-center justify-center rounded-full transition-colors duration-150 disabled:opacity-50'

function PillTip({ content, children }: { content: ReactNode; children: ReactNode }) {
  return (
    <Tooltip content={content} side="bottom">
      {children}
    </Tooltip>
  )
}

function statusLabel(status: LiveStatus): string | null {
  if (status === 'starting') return t('overlay.pill.starting')
  if (status === 'stopping') return t('overlay.pill.stopping')
  if (status === 'processing') return t('overlay.pill.processing')
  return null
}

/** Live dot + elapsed timer + Me/Them meters. */
function SessionStatus({ capture }: { capture: CaptureLike }) {
  const status = useLive((s) => s.state.status)
  const startedAt = useLive((s) => s.state.startedAt)
  const audio = useLive((s) => s.state.audio)
  const elapsed = useElapsed(startedAt, status === 'live')
  const live = status === 'live'
  const label = live ? t('overlay.pill.listening') : statusLabel(status)
  return (
    <div className="flex h-8 items-center gap-2.5 rounded-full px-2.5">
      {/* Announce status changes only; the ticking timer stays out of the live region. */}
      <span className="sr-only" aria-live="polite">
        {label}
      </span>
      <span
        className="flex items-center gap-1.5"
        title={live ? `${label} · ${t('overlay.pill.elapsed')}` : (label ?? undefined)}
      >
        <span
          aria-hidden
          data-status={status}
          className={cn(
            'h-2 w-2 rounded-full',
            live && 'animate-pulse-dot bg-success',
            (status === 'starting' || status === 'stopping') && 'bg-warning',
            status === 'processing' && 'bg-accent-2',
          )}
        />
        {live ? (
          <span className="tabular min-w-[34px] text-[13px] font-semibold text-fg">
            {formatElapsed(elapsed ?? 0)}
          </span>
        ) : (
          <span aria-hidden className="text-[12.5px] font-medium text-muted">
            {label}
          </span>
        )}
      </span>
      {status === 'live' || status === 'starting' ? (
        <ActivityMeter capture={capture} audio={audio} />
      ) : null}
    </div>
  )
}

/**
 * The always-visible pill: logo (toggles the panel), session status, Hide and Stop. The pill
 * body is the window's drag handle; its controls opt out of dragging.
 */
export function Pill({ capture }: { capture: CaptureLike }) {
  const status = useLive((s) => s.state.status)
  const expanded = useUi((s) => s.expanded)
  const hideHidesWidget = useSettings((s) => s.settings.general.hideHidesWidget)
  const inSession = status !== 'idle'
  const canStop = status === 'live' || status === 'starting'
  // "Hide" collapses the panel (or hides the widget, per settings); once collapsed it reads "Show".
  const showsExpand = !expanded && !hideHidesWidget

  return (
    <div
      data-hit
      className="drag flex h-11 shrink-0 items-center gap-1 rounded-full border border-ov-line bg-ov-pill px-1.5 shadow-panel"
    >
      <PillTip content={expanded ? t('overlay.pill.hidePanel') : t('overlay.pill.showPanel')}>
        <button
          type="button"
          aria-label={expanded ? t('overlay.pill.hidePanel') : t('overlay.pill.showPanel')}
          aria-expanded={expanded}
          onClick={() => void setExpanded(!expanded)}
          className={cn(pillButton, 'w-8 hover:bg-panel-3 active:scale-95')}
        >
          <LogoMark size={22} title="" />
        </button>
      </PillTip>

      {inSession ? <SessionStatus capture={capture} /> : null}

      <PillTip
        content={
          showsExpand
            ? t('overlay.pill.expandTip')
            : hideHidesWidget
              ? t('overlay.pill.hideWidgetTip')
              : t('overlay.pill.collapseTip')
        }
      >
        <button
          type="button"
          onClick={() => (showsExpand ? void setExpanded(true) : hideFromPill())}
          className={cn(
            pillButton,
            'gap-1 bg-panel-3 pr-3.5 pl-2.5 text-[13px] font-semibold text-fg hover:bg-panel-4',
          )}
        >
          {showsExpand ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          {showsExpand ? t('overlay.pill.show') : t('overlay.pill.hide')}
        </button>
      </PillTip>

      {inSession ? (
        <PillTip content={t('overlay.pill.stop')}>
          <button
            type="button"
            aria-label={t('overlay.pill.stop')}
            disabled={!canStop}
            onClick={stopSession}
            className={cn(
              pillButton,
              'w-8 bg-panel-3 text-fg hover:bg-danger hover:text-white disabled:hover:bg-panel-3 disabled:hover:text-fg',
            )}
          >
            {status === 'stopping' || status === 'processing' ? (
              <Spinner size={13} />
            ) : (
              <Square size={11} fill="currentColor" strokeWidth={0} />
            )}
          </button>
        </PillTip>
      ) : (
        <PillTip content={t('overlay.pill.start')}>
          <button
            type="button"
            aria-label={t('overlay.pill.start')}
            onClick={startSession}
            className={cn(pillButton, 'bluely-gradient w-8 text-white hover:brightness-110')}
          >
            <Play size={13} fill="currentColor" strokeWidth={0} className="translate-x-px" />
          </button>
        </PillTip>
      )}
    </div>
  )
}
