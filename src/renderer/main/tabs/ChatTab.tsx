import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { ArrowUp, MessagesSquare } from 'lucide-react'
import { t } from '@shared/i18n'
import type { AiCard } from '@shared/types'
import { cn } from '../../components/ui'
import { errorMessage, invoke } from '../../lib/ipc'
import { AnswerCard } from '../components/AnswerCard'
import { failAiCard, seedAiCards, useMeetingChatCards } from '../hooks/useAiStream'
import { pendingCard } from '../lib/aiReducer'
import { useNav } from '../router'
import { toast } from '../stores/toast'

/** A question sent with 'sessions:chat' whose ai:card may not have arrived yet. */
export interface AskedQuestion {
  id: string
  question: string
  createdAt: number
}

/**
 * Chat state that must survive switching tabs (inactive tab panels unmount), so the meeting
 * page owns it: the unsent question and the questions still waiting for their card.
 */
export interface ChatDraft {
  input: string
  asked: AskedQuestion[]
}

export interface ChatTabProps {
  sessionId: string
  draft: ChatDraft
  setDraft: Dispatch<SetStateAction<ChatDraft>>
}

let localIds = 0
const STICK_PX = 96

function Bubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="selectable max-w-[80%] rounded-2xl rounded-br-md bg-accent-soft px-4 py-2.5 text-[14px] leading-[1.55] whitespace-pre-wrap text-fg">
        {text}
      </div>
    </div>
  )
}

/** "Ask about this meeting": history from 'ai:getCards', new questions via 'sessions:chat'. */
export function ChatTab({ sessionId, draft, setDraft }: ChatTabProps) {
  const nav = useNav()
  const cards = useMeetingChatCards(sessionId)
  const { asked, input } = draft
  const setInput = (value: string) => setDraft((d) => ({ ...d, input: value }))
  const [sending, setSending] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  useEffect(() => {
    invoke('ai:getCards', { scope: 'meeting_chat', sessionId })
      .then(seedAiCards)
      .catch(() => undefined)
  }, [sessionId])

  // Questions whose ai:card has not arrived yet render as placeholders.
  const items: AiCard[] = useMemo(() => {
    const known = new Set(cards.map((c) => c.id))
    const waiting = asked
      .filter((a) => !known.has(a.id))
      .map((a) => ({
        ...pendingCard(a.id, 'meeting_chat', a.question, sessionId),
        createdAt: a.createdAt,
      }))
    return [...cards, ...waiting].sort((a, b) => a.createdAt - b.createdAt)
  }, [cards, asked, sessionId])

  useEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [items])

  const send = (raw: string) => {
    const question = raw.trim()
    if (!question || sending) return
    setSending(true)
    stick.current = true
    invoke('sessions:chat', { id: sessionId, question })
      .then(({ id }) => {
        setDraft((d) => ({
          input: '',
          asked: [...d.asked, { id, question, createdAt: Date.now() }],
        }))
      })
      .catch((err: unknown) => {
        const id = `local-chat-${++localIds}`
        failAiCard(
          pendingCard(id, 'meeting_chat', question, sessionId),
          `${t('session.chat.askFailed')}: ${errorMessage(err)}`,
        )
        setInput('')
        toast(t('session.chat.askFailed'), 'error')
      })
      .finally(() => setSending(false))
  }

  const suggestions = [
    t('session.chat.suggestion1'),
    t('session.chat.suggestion2'),
    t('session.chat.suggestion3'),
  ]

  return (
    <div className="flex h-full flex-col" data-testid="chat-tab">
      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX
        }}
      >
        <div className="mx-auto max-w-[920px] px-10 py-7">
          {items.length === 0 ? (
            <div className="flex flex-col items-center py-12 text-center">
              <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl border border-line bg-panel text-subtle">
                <MessagesSquare size={20} />
              </div>
              <div className="text-[15px] font-semibold text-fg">{t('session.chat.title')}</div>
              <div className="mt-1.5 max-w-[400px] text-[13px] text-muted">
                {t('session.chat.emptyBody')}
              </div>
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                {suggestions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => send(s)}
                    className="h-8 rounded-full border border-line bg-panel px-3.5 text-[12.5px] text-muted transition-colors hover:border-accent/40 hover:text-fg"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {items.map((card) => (
                <div key={card.id} className="flex flex-col gap-2.5 animate-fade-in">
                  <Bubble text={card.question ?? card.label} />
                  <AnswerCard
                    card={card}
                    onRetry={() => send(card.question ?? card.label)}
                    onOpenCitation={(id) => nav.openSession(id)}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="shrink-0 border-t border-line bg-panel">
        <form
          className="mx-auto max-w-[920px] px-10 pt-3 pb-2.5"
          onSubmit={(e) => {
            e.preventDefault()
            send(input)
          }}
        >
          <div className="flex items-end gap-2 rounded-2xl border border-line bg-panel-2 py-1.5 pr-1.5 pl-3.5 transition-colors focus-within:border-accent/60">
            <textarea
              value={input}
              rows={1}
              maxLength={4000}
              placeholder={t('session.chat.placeholder')}
              aria-label={t('session.chat.placeholder')}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  send(input)
                }
              }}
              className="selectable max-h-[140px] min-h-[30px] flex-1 resize-none bg-transparent py-[5px] text-[14px] leading-[1.45] text-fg outline-none [field-sizing:content] placeholder:text-subtle focus-visible:outline-none"
            />
            <button
              type="submit"
              aria-label={t('session.chat.send')}
              disabled={!input.trim() || sending}
              className={cn(
                'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white transition-[filter,opacity] duration-150',
                'bluely-gradient hover:brightness-110 disabled:opacity-40',
              )}
            >
              <ArrowUp size={16} strokeWidth={2.4} />
            </button>
          </div>
          <div className="mt-1.5 px-1 text-[11px] text-subtle">{t('session.chat.sendHint')}</div>
        </form>
      </div>
    </div>
  )
}
