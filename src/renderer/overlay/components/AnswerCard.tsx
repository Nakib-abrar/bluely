import {
  CircleAlert,
  MessageCircle,
  Monitor,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Square,
  Users,
  WandSparkles,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import { memo } from 'react'
import { t, type MessageKey } from '@shared/i18n'
import type { AiCard, AiMessageKind } from '@shared/types'
import { Button, cn, CopyButton, Markdown, SpeedReadout } from '../../components/ui'
import { cancelCard, retryCard } from '../actions'

const ACTION_META: Partial<Record<AiMessageKind, { icon: LucideIcon; label: MessageKey }>> = {
  say: { icon: WandSparkles, label: 'actions.say' },
  followups: { icon: MessageCircle, label: 'actions.followups' },
  recap: { icon: RotateCcw, label: 'actions.recap' },
  factcheck: { icon: ShieldCheck, label: 'actions.factcheck' },
  who: { icon: Users, label: 'actions.who' },
}

/** Right-aligned source: the typed question, an "Assist" pill, an action chip or "Auto". */
function SourceChip({ card }: { card: AiCard }) {
  if (card.kind === 'ask') {
    return (
      <div className="flex justify-end pl-12">
        <div className="selectable rounded-2xl rounded-br-md bg-accent-strong px-3 py-1.5 text-[13.5px] leading-snug font-medium break-words text-white shadow-soft">
          {card.question ?? card.label}
        </div>
      </div>
    )
  }
  if (card.kind === 'assist') {
    return (
      <div className="flex justify-end">
        <span className="bluely-gradient bluely-glow inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-semibold text-white">
          <Sparkles size={13} />
          {t('actions.assist')}
        </span>
      </div>
    )
  }
  if (card.kind === 'auto') {
    return (
      <div className="flex justify-end">
        <span className="inline-flex items-center gap-1 text-[12px] font-medium text-subtle">
          <Zap size={12} className="text-accent-text/80" />
          {t('actions.autoLabel')}
        </span>
      </div>
    )
  }
  const meta = ACTION_META[card.kind]
  const Icon = meta?.icon ?? Sparkles
  return (
    <div className="flex justify-end">
      <span className="inline-flex h-7 items-center gap-1.5 rounded-full bg-accent-soft px-3 text-[12.5px] font-semibold text-accent-text">
        <Icon size={13} />
        {meta ? t(meta.label) : card.label}
      </span>
    </div>
  )
}

function Thinking() {
  return (
    <div className="flex h-[23px] items-center gap-2 text-[13px] text-subtle">
      <span className="ov-thinking" aria-hidden>
        <span />
        <span />
        <span />
      </span>
      {t('overlay.list.thinking')}
    </div>
  )
}

/**
 * One streamed answer, laid out like a chat turn: the source on the right, then
 * "Viewed screen", the markdown answer and a footer (copy, speed, stop / retry).
 * The footer always reserves its row so nothing jumps when streaming ends.
 */
export const AnswerCard = memo(function AnswerCard({ card }: { card: AiCard }) {
  const streaming = card.status === 'streaming'
  const failed = card.status === 'error' && !!card.error
  const hasText = card.text.length > 0
  // Reserved while streaming so the row doesn't pop in when the answer finishes.
  const showFooter = streaming || hasText || !!card.stats || card.status === 'cancelled'
  return (
    <article
      className="animate-fade-in"
      aria-busy={streaming}
      data-card-id={card.id}
      data-status={card.status}
    >
      <SourceChip card={card} />
      {card.usedScreen ? (
        <div className="mt-2.5 flex items-center gap-1.5 text-[12px] font-medium text-subtle">
          <Monitor size={12} />
          {t('actions.viewedScreen')}
        </div>
      ) : null}
      {hasText || streaming ? (
        <div className={cn('min-h-[23px]', card.usedScreen ? 'mt-1' : 'mt-2.5')}>
          {hasText ? (
            <Markdown text={card.text} className={cn('text-[14px]', streaming && 'ov-streaming')} />
          ) : (
            <Thinking />
          )}
        </div>
      ) : null}
      {failed && card.error ? (
        <div
          role="alert"
          className="mt-2.5 flex items-center gap-2 rounded-lg border border-danger/25 bg-danger-soft py-1.5 pr-1.5 pl-2.5 text-[12.5px] text-fg"
        >
          <CircleAlert size={14} className="shrink-0 text-danger" />
          <span className="min-w-0 flex-1">
            {card.error.message || t(`errors.${card.error.code}`)}
          </span>
          {card.error.retryable ? (
            <Button
              size="sm"
              variant="ghost"
              icon={<RotateCcw size={13} />}
              onClick={() => void retryCard(card)}
              className="h-6 text-accent-text hover:text-accent-text"
            >
              {t('common.retry')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {showFooter ? (
        <footer className="mt-1 flex h-7 items-center gap-1.5">
          {hasText && !streaming ? (
            <CopyButton text={card.text} className="-ml-1.5" />
          ) : (
            <span className="w-0" />
          )}
          <div className="min-w-0 flex-1">
            {card.stats ? <SpeedReadout stats={card.stats} /> : null}
          </div>
          {streaming ? (
            <Button
              size="sm"
              variant="ghost"
              icon={<Square size={10} fill="currentColor" strokeWidth={0} />}
              onClick={() => cancelCard(card.id)}
              className="h-6 px-2 text-[12px]"
            >
              {t('overlay.list.stop')}
            </Button>
          ) : card.status === 'cancelled' ? (
            <span className="text-[12px] text-subtle">{t('overlay.list.cancelled')}</span>
          ) : null}
        </footer>
      ) : null}
    </article>
  )
})
