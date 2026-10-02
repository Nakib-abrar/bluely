import { memo } from 'react'
import { t } from '@shared/i18n'
import type { TranscriptLine } from '@shared/types'
import { cn } from '../../components/ui'
import { invoke } from '../../lib/ipc'
import { reportError } from '../actions'
import { useStickToBottom } from '../hooks/useStickToBottom'
import { formatOffset } from '../lib/time'
import { useLive } from '../stores/liveStore'
import { JumpToLatest } from './JumpToLatest'

/** One line; a speaker header is shown when the speaker changes. */
const Line = memo(function Line({
  line,
  showSpeaker,
}: {
  line: TranscriptLine
  showSpeaker: boolean
}) {
  const me = line.channel === 'me'
  return (
    <div className={cn(showSpeaker && 'mt-3 first:mt-0')} data-line-id={line.id}>
      {showSpeaker ? (
        <div className="mb-0.5 flex items-baseline gap-2">
          <span
            className={cn(
              'text-[11.5px] font-semibold tracking-wide uppercase',
              me ? 'text-accent-text' : 'text-fg',
            )}
          >
            {me ? t('common.me') : t('common.them')}
          </span>
          <span className="tabular text-[11px] text-subtle">{formatOffset(line.startMs)}</span>
        </div>
      ) : null}
      <p
        className={cn(
          'selectable text-[13.5px] leading-relaxed break-words',
          line.isFinal ? 'text-fg/90' : 'text-muted italic',
        )}
        title={line.isFinal ? undefined : t('overlay.transcript.partial')}
      >
        {line.text}
      </p>
    </div>
  )
})

/**
 * The overlay shows the recent part of the call; long calls would otherwise keep thousands
 * of nodes alive in an always-on-top window. The full transcript lives in the main window.
 */
const MAX_RENDERED_LINES = 400

/** Live transcript, speaker-labelled, following new lines while at the bottom. */
export function TranscriptView() {
  const all = useLive((s) => s.lines)
  const sessionId = useLive((s) => s.sessionId)
  const { scrollRef, contentRef, atBottom, jumpToLatest } = useStickToBottom('transcript')
  const hidden = Math.max(0, all.length - MAX_RENDERED_LINES)
  const lines = hidden ? all.slice(hidden) : all
  return (
    <>
      <div ref={scrollRef} className="ov-scroll h-full overflow-y-auto" data-list="transcript">
        <div ref={contentRef} className="flex min-h-full flex-col px-4 pt-3 pb-4">
          {hidden && sessionId ? (
            <div className="mb-3 flex items-center justify-center gap-1.5 text-[12px] text-subtle">
              {t('overlay.transcript.truncated', { count: MAX_RENDERED_LINES })}
              <button
                type="button"
                onClick={() => {
                  invoke('app:openMainWindow', {
                    route: { name: 'session', sessionId, tab: 'transcript' },
                  }).catch(reportError)
                }}
                className="no-drag rounded px-1 font-medium text-accent-text hover:underline"
              >
                {t('overlay.transcript.openFull')}
              </button>
            </div>
          ) : null}
          {lines.length === 0 ? (
            <div className="flex flex-1 items-center justify-center px-8 pb-6 text-center text-[13px] text-muted">
              {t('overlay.transcript.empty')}
            </div>
          ) : (
            lines.map((line, i) => (
              <Line
                key={line.id}
                line={line}
                showSpeaker={i === 0 || lines[i - 1]?.channel !== line.channel}
              />
            ))
          )}
        </div>
      </div>
      {!atBottom ? <JumpToLatest onClick={jumpToLatest} /> : null}
    </>
  )
}
