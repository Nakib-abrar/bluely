import { AlertCircle, FileText, RotateCcw } from 'lucide-react'
import { t } from '@shared/i18n'
import type { AiCard } from '@shared/types'
import { Button, cn, CopyButton, Markdown, SpeedReadout } from '../../components/ui'
import { formatShortDate } from '../lib/text'
import { SparkGlyph } from './SparkGlyph'

export interface AnswerCardProps {
  card: AiCard
  /** Shown as the card heading (search answers); chat shows the question as a bubble instead. */
  heading?: string
  onRetry?: () => void
  onOpenCitation?: (sessionId: string) => void
  className?: string
}

/** Streaming cursor glyph appended to partial answers. */
const CARET = ' ▍'

function Thinking() {
  return (
    <div className="flex items-center gap-2 text-[13px] text-muted" role="status">
      <span className="flex gap-1" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="animate-pulse-dot h-1.5 w-1.5 rounded-full bg-accent-2"
            style={{ animationDelay: `${i * 160}ms` }}
          />
        ))}
      </span>
      {t('session.answer.thinking')}
    </div>
  )
}

/**
 * One streamed AI answer: markdown body, citations, copy button and the ⚡ speed line.
 * Text grows in place while streaming; the footer only appears when done, so nothing
 * above the cursor moves.
 */
export function AnswerCard({ card, heading, onRetry, onOpenCitation, className }: AnswerCardProps) {
  const streaming = card.status === 'streaming'
  const hasText = card.text.trim().length > 0

  return (
    <article
      className={cn('rounded-2xl border border-line bg-panel px-5 py-4 shadow-soft', className)}
      aria-busy={streaming}
      data-testid="answer-card"
    >
      <header className="mb-2.5 flex items-center gap-2.5">
        <span className="bluely-gradient flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-white">
          <SparkGlyph size={13} />
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-fg">
          {heading ?? t('common.appName')}
        </span>
        {card.status === 'done' && hasText ? (
          <CopyButton text={card.text} label={t('session.answer.copy')} />
        ) : null}
      </header>

      {hasText ? (
        // The caret is appended to the text so it sits inline after the last word.
        <Markdown text={streaming ? `${card.text}${CARET}` : card.text} className="text-[14px]" />
      ) : streaming ? (
        <Thinking />
      ) : null}

      {card.status === 'error' ? (
        <div
          className="mt-2 flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-fg"
          role="alert"
        >
          <AlertCircle size={15} className="mt-0.5 shrink-0 text-danger" />
          <span className="min-w-0 flex-1">{card.error?.message ?? t('errors.unknown')}</span>
          {onRetry ? (
            <Button
              size="sm"
              variant="ghost"
              icon={<RotateCcw size={13} />}
              onClick={onRetry}
              className="-my-1"
            >
              {t('common.retry')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {card.status === 'cancelled' ? (
        <div className="mt-2 text-[12.5px] text-subtle">{t('session.answer.cancelled')}</div>
      ) : null}

      {card.citations.length > 0 ? (
        <div className="mt-3.5 flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[11.5px] font-medium text-subtle">
            {t('session.answer.sources')}
          </span>
          {card.citations.map((c) => (
            <button
              key={`${c.sessionId}-${c.startedAt}`}
              type="button"
              disabled={!onOpenCitation}
              onClick={() => onOpenCitation?.(c.sessionId)}
              className="inline-flex h-6 max-w-[280px] items-center gap-1.5 rounded-full border border-line bg-panel-2 px-2.5 text-[12px] text-muted transition-colors hover:border-accent/40 hover:text-fg"
            >
              <FileText size={11.5} className="shrink-0 text-subtle" />
              <span className="truncate">
                {c.title.trim() || t('home.untitled')} · {formatShortDate(c.startedAt)}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      {card.stats ? <SpeedReadout stats={card.stats} className="mt-3" /> : null}
    </article>
  )
}
