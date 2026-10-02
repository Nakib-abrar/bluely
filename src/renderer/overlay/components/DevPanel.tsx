import { Gauge, X } from 'lucide-react'
import { t } from '@shared/i18n'
import { keybindDisplay } from '@shared/keybinds'
import type { LatencyTrace } from '@shared/types'
import { cn, Keys } from '../../components/ui'
import { useSettings } from '../../stores/settings'
import { stageSeconds } from '../lib/time'
import { useLive } from '../stores/liveStore'
import { useUi } from '../stores/uiStore'

/** Totals at or above this (seconds) are highlighted: the "feels slow" line. */
const SLOW_TOTAL_SEC = 2

/** VAD end → first token; manual requests (no VAD) start at the earliest stage they have. */
function totalSeconds(tr: LatencyTrace): number | null {
  const start = tr.vadEndAt ?? tr.sttDoneAt ?? tr.promptBuiltAt ?? tr.requestSentAt
  return stageSeconds(start, tr.firstTokenAt)
}

function fmt(sec: number | null): string {
  return sec == null ? '—' : sec.toFixed(2)
}

function shortModel(model: string): string {
  const slash = model.lastIndexOf('/')
  return slash >= 0 ? model.slice(slash + 1) : model
}

/** Ctrl+Shift+D: per-request latency stages, for tuning. */
export function DevPanel() {
  const traces = useLive((s) => s.traces)
  const binding = useSettings((s) => s.settings.keybinds.devPanel)
  const keys = keybindDisplay('devPanel', binding)
  const rows = [...traces].reverse()
  const th = 'px-1 py-1 font-medium text-subtle'
  const td = 'px-1 py-[3px]'
  const stages = [
    { label: t('overlay.dev.vadToStt'), tip: t('overlay.dev.vadToSttTip') },
    { label: t('overlay.dev.sttToPrompt'), tip: t('overlay.dev.sttToPromptTip') },
    { label: t('overlay.dev.promptToSent'), tip: t('overlay.dev.promptToSentTip') },
    { label: t('overlay.dev.sentToFirst'), tip: t('overlay.dev.sentToFirstTip') },
  ]

  return (
    <section
      aria-label={t('overlay.dev.title')}
      className="mx-3 mb-2 shrink-0 animate-fade-in rounded-lg border border-line bg-panel/70 text-[11px]"
    >
      <div className="flex items-center gap-2 border-b border-line py-1 pr-1 pl-2.5">
        <Gauge size={13} className="text-accent-text" />
        <span className="font-semibold text-fg">{t('overlay.dev.title')}</span>
        <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-subtle">
          {t('overlay.dev.hint', { count: rows.length })}
          {keys.length ? <span aria-hidden>·</span> : null}
          <Keys
            keys={keys}
            className="[&>kbd]:h-4 [&>kbd]:min-w-4 [&>kbd]:px-1 [&>kbd]:text-[10px]"
          />
        </span>
        <button
          type="button"
          aria-label={t('overlay.dev.close')}
          onClick={() => useUi.getState().toggleDev()}
          className="no-drag inline-flex h-6 w-6 items-center justify-center rounded-md text-muted hover:bg-panel-3 hover:text-fg"
        >
          <X size={13} />
        </button>
      </div>
      {rows.length === 0 ? (
        <div className="px-2.5 py-2 text-subtle">{t('overlay.dev.empty')}</div>
      ) : (
        <div className="max-h-[150px] overflow-y-auto">
          <table className="tabular w-full table-fixed border-collapse">
            <colgroup>
              <col className="w-[60px]" />
              <col />
              <col className="w-[46px]" />
              <col className="w-[50px]" />
              <col className="w-[42px]" />
              <col className="w-[48px]" />
              <col className="w-[44px]" />
              <col className="w-[40px]" />
            </colgroup>
            <thead className="sticky top-0 bg-panel-2">
              <tr className="text-left">
                <th className={cn(th, 'pl-2')}>{t('overlay.dev.kind')}</th>
                <th className={th}>{t('overlay.dev.model')}</th>
                {stages.map((st) => (
                  <th key={st.label} className={cn(th, 'text-right')} title={st.tip}>
                    {st.label}
                  </th>
                ))}
                <th className={cn(th, 'text-right')} title={t('overlay.dev.totalTip')}>
                  {t('overlay.dev.total')}
                </th>
                <th className={cn(th, 'pr-2 text-right')}>{t('overlay.dev.tokens')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((tr) => {
                const total = totalSeconds(tr)
                const slow = total != null && total >= SLOW_TOTAL_SEC
                const cells = [
                  stageSeconds(tr.vadEndAt, tr.sttDoneAt),
                  stageSeconds(tr.sttDoneAt, tr.promptBuiltAt),
                  stageSeconds(tr.promptBuiltAt, tr.requestSentAt),
                  stageSeconds(tr.requestSentAt, tr.firstTokenAt),
                ]
                return (
                  <tr key={tr.id} className="border-t border-line text-muted" data-trace={tr.id}>
                    <td className={cn(td, 'pl-2 text-fg')}>{tr.kind}</td>
                    <td className={cn(td, 'truncate')} title={tr.model}>
                      {shortModel(tr.model)}
                    </td>
                    {cells.map((sec, i) => (
                      <td key={i} className={cn(td, 'text-right')}>
                        {fmt(sec)}
                      </td>
                    ))}
                    <td
                      className={cn(
                        td,
                        'text-right font-semibold',
                        slow ? 'text-warning' : 'text-fg',
                      )}
                      data-slow={slow}
                    >
                      {fmt(total)}
                    </td>
                    <td className={cn(td, 'pr-2 text-right')}>{tr.promptTokensEstimate ?? '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
