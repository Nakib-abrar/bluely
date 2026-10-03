import { useDeferredValue, useMemo } from 'react'
import { Filter, MessageSquareText, X } from 'lucide-react'
import { t } from '@shared/i18n'
import type { SessionDetail } from '@shared/types'
import { cn, CopyButton, Input } from '../../components/ui'
import { HighlightedText } from '../components/HighlightedText'
import { transcriptStamp, transcriptToText } from '../lib/copyText'
import { highlightText } from '../lib/snippet'
import { TabEmpty } from './TabState'

export interface TranscriptTabProps {
  detail: SessionDetail
  /** Owned by the meeting page so the filter survives switching tabs. */
  filter: string
  setFilter(filter: string): void
}

/** Timestamped Me/Them transcript with a client-side filter. */
export function TranscriptTab({ detail, filter, setFilter }: TranscriptTabProps) {
  const deferred = useDeferredValue(filter)
  const lines = detail.transcript
  const needle = deferred.trim().toLowerCase()
  const shown = useMemo(
    () => (needle ? lines.filter((l) => l.text.toLowerCase().includes(needle)) : lines),
    [lines, needle],
  )
  const copyText = useMemo(() => transcriptToText(lines), [lines])

  if (lines.length === 0) {
    return (
      <TabEmpty
        icon={<MessageSquareText size={20} />}
        title={t('session.transcript.empty')}
        body={t('session.transcript.emptyBody')}
      />
    )
  }

  return (
    <div data-testid="transcript-tab">
      <div className="mb-4 flex items-center gap-3">
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && filter) {
              e.preventDefault()
              setFilter('')
            }
          }}
          placeholder={t('session.transcript.filter')}
          aria-label={t('session.transcript.filter')}
          icon={<Filter size={13} />}
          className="w-[280px]"
          right={
            filter ? (
              <button
                type="button"
                aria-label={t('session.transcript.clearFilter')}
                onClick={() => setFilter('')}
                className="-mr-1 inline-flex h-5 w-5 items-center justify-center rounded text-subtle hover:text-fg"
              >
                <X size={12} />
              </button>
            ) : null
          }
        />
        <span className="tabular text-[12.5px] text-subtle">
          {needle
            ? t('session.transcript.matches', { count: shown.length, total: lines.length })
            : t('session.transcript.lines', { count: lines.length })}
        </span>
        <CopyButton text={copyText} label={t('session.transcript.copy')} className="ml-auto" />
      </div>

      {shown.length === 0 ? (
        <div className="py-10 text-center text-[13px] text-subtle">
          {t('session.transcript.noMatches', { query: deferred.trim() })}
        </div>
      ) : (
        <ol className="selectable">
          {shown.map((line) => {
            const me = line.channel === 'me'
            return (
              <li
                key={line.id}
                className="grid grid-cols-[64px_48px_minmax(0,1fr)] gap-x-2 rounded-lg px-2 py-[7px] transition-colors hover:bg-panel"
              >
                <span className="tabular pt-[2px] text-[12px] text-subtle">
                  {transcriptStamp(line.startMs)}
                </span>
                <span
                  className={cn(
                    'pt-[1px] text-[12.5px] font-semibold',
                    me ? 'text-accent-text' : 'text-muted',
                  )}
                >
                  {me ? t('common.me') : t('common.them')}
                </span>
                <span
                  className={cn(
                    'text-[14px] leading-[1.6]',
                    line.isFinal ? 'text-fg' : 'text-muted italic',
                  )}
                >
                  <HighlightedText parts={highlightText(line.text, needle)} />
                </span>
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}
