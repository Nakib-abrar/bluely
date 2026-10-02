import { forwardRef, useImperativeHandle, useState } from 'react'
import { ArrowRight, CornerDownLeft } from 'lucide-react'
import { t } from '@shared/i18n'
import { errorMessage, invoke } from '../../lib/ipc'
import { failAiCard, useAiStream } from '../hooks/useAiStream'
import { pendingCard } from '../lib/aiReducer'
import { useNav } from '../router'
import { AnswerCard } from './AnswerCard'
import { SparkGlyph } from './SparkGlyph'

export interface AskAcrossHandle {
  /** Asks the current question (Enter in the search box). */
  ask(): void
}

interface Asked {
  question: string
  id: string
}

let localIds = 0

/**
 * "Ask Bluely across your meetings": a prominent prompt for question-like searches that
 * turns into the streamed answer card ('search:ask' + ai:* events) once asked.
 */
export const AskAcross = forwardRef<AskAcrossHandle, { question: string }>(function AskAcross(
  { question },
  ref,
) {
  const nav = useNav()
  const q = question.trim()
  const [asked, setAsked] = useState<Asked | null>(null)
  const current = asked && asked.question === q ? asked : null
  const streamed = useAiStream(current?.id ?? null)

  const ask = () => {
    if (!q) return
    invoke('search:ask', { question: q })
      .then(({ id }) => setAsked({ question: q, id }))
      .catch((err: unknown) => {
        const id = `local-ask-${++localIds}`
        failAiCard(
          pendingCard(id, 'search', q, null),
          `${t('home.search.askFailed')}: ${errorMessage(err)}`,
        )
        setAsked({ question: q, id })
      })
  }

  useImperativeHandle(ref, () => ({
    ask() {
      if (!current) ask()
    },
  }))

  if (current) {
    const card = streamed ?? pendingCard(current.id, 'search', q, null)
    return (
      <AnswerCard
        card={card}
        heading={q}
        onRetry={ask}
        onOpenCitation={(id) => nav.openSession(id)}
        className="min-h-[124px]"
      />
    )
  }

  return (
    <button
      type="button"
      data-result-item=""
      onClick={ask}
      data-testid="ask-across"
      className="group flex w-full items-center gap-4 rounded-2xl border border-accent/30 bg-accent-soft px-5 py-4 text-left transition-colors duration-150 hover:border-accent/55 focus-visible:-outline-offset-2"
    >
      <span className="bluely-gradient bluely-glow flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-white">
        <SparkGlyph size={20} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[14.5px] font-semibold text-fg">
          {t('home.search.askTitle')}
        </span>
        <span className="mt-0.5 block truncate text-[13px] text-muted">“{q}”</span>
      </span>
      <span className="flex shrink-0 items-center gap-2 text-[12.5px] font-medium text-accent-text">
        <span className="inline-flex h-[20px] items-center rounded-[5px] border border-accent/30 px-1.5">
          <CornerDownLeft size={12} aria-hidden="true" />
        </span>
        {t('home.search.askButton')}
        <ArrowRight
          size={15}
          aria-hidden="true"
          className="transition-transform duration-150 group-hover:translate-x-0.5"
        />
      </span>
    </button>
  )
})
