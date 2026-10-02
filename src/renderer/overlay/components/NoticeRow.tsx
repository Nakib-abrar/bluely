import { CircleAlert, X } from 'lucide-react'
import { useEffect } from 'react'
import { t } from '@shared/i18n'
import { openSettings } from '../actions'
import { useUi } from '../stores/uiStore'

/** How long an inline request error stays up. */
const NOTICE_MS = 7000

/** Inline message for requests that failed before an answer card existed (e.g. no API key). */
export function NoticeRow() {
  const notice = useUi((s) => s.notice)
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => useUi.getState().clearNotice(notice.id), NOTICE_MS)
    return () => clearTimeout(timer)
  }, [notice])
  if (!notice) return null
  return (
    <div
      role="alert"
      className="mb-2 flex animate-fade-in items-center gap-2 rounded-lg border border-danger/25 bg-danger-soft py-1.5 pr-1.5 pl-2.5 text-[12.5px] text-fg"
    >
      <CircleAlert size={14} className="shrink-0 text-danger" />
      <span className="min-w-0 flex-1">{notice.message}</span>
      {notice.settingsPage ? (
        <button
          type="button"
          onClick={() => openSettings(notice.settingsPage ?? undefined)}
          className="no-drag h-6 shrink-0 rounded-md px-2 text-[12px] font-semibold text-accent-text hover:bg-panel-3"
        >
          {t('overlay.warnings.openSettings')}
        </button>
      ) : null}
      <button
        type="button"
        aria-label={t('overlay.warnings.dismiss')}
        onClick={() => useUi.getState().clearNotice(notice.id)}
        className="no-drag inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted hover:bg-panel-3 hover:text-fg"
      >
        <X size={13} />
      </button>
    </div>
  )
}
