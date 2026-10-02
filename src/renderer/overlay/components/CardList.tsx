import { Sparkles } from 'lucide-react'
import { t } from '@shared/i18n'
import { LogoMark } from '../../components/ui'
import { runAssist } from '../actions'
import { useStickToBottom } from '../hooks/useStickToBottom'
import { useLive } from '../stores/liveStore'
import { AnswerCard } from './AnswerCard'
import { JumpToLatest } from './JumpToLatest'

function EmptyInsights() {
  const status = useLive((s) => s.state.status)
  const idle = status === 'idle' || status === 'processing'
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 pb-6 text-center">
      <LogoMark size={30} className="opacity-90" title="" />
      {idle ? (
        <div className="max-w-[320px]">
          <div className="text-[13.5px] font-medium text-fg">{t('overlay.list.idleTitle')}</div>
          <div className="mt-1 text-[12.5px] text-muted">{t('overlay.list.idleHint')}</div>
        </div>
      ) : (
        <div className="max-w-[340px] text-[13px] leading-relaxed text-muted">
          <div className="font-medium text-fg">{t('overlay.list.emptyTitle')}</div>
          <div className="mt-1">
            {t('overlay.list.emptyHintBefore')}{' '}
            <button
              type="button"
              onClick={() => void runAssist()}
              className="no-drag inline-flex translate-y-[3px] items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-[12px] font-semibold text-accent-text hover:bg-accent/25"
            >
              <Sparkles size={12} />
              {t('actions.assist')}
            </button>{' '}
            {t('overlay.list.emptyHintAfter')}
          </div>
        </div>
      )}
    </div>
  )
}

/** Screen-reader announcement of the latest finished answer (streaming text is not read). */
function AnswerAnnouncer() {
  const latest = useLive((s) => s.cards.findLast((c) => c.status === 'done'))
  return (
    <div className="sr-only" aria-live="polite">
      {latest ? `${t('overlay.list.answerReady')}: ${latest.text.slice(0, 600)}` : ''}
    </div>
  )
}

/** Insights: answer cards, newest at the bottom, following the stream while at the bottom. */
export function CardList() {
  const cards = useLive((s) => s.cards)
  const { scrollRef, contentRef, atBottom, jumpToLatest } = useStickToBottom('insights')
  return (
    <>
      <div ref={scrollRef} className="ov-scroll h-full overflow-y-auto" data-list="insights">
        <div ref={contentRef} className="flex min-h-full flex-col gap-6 px-4 pt-3 pb-4">
          {cards.length === 0 ? (
            <EmptyInsights />
          ) : (
            cards.map((card) => <AnswerCard key={card.id} card={card} />)
          )}
        </div>
      </div>
      {!atBottom ? <JumpToLatest onClick={jumpToLatest} /> : null}
      <AnswerAnnouncer />
    </>
  )
}
