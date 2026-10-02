import { ArrowUp, Eye, EyeOff, Sparkles, Zap } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef } from 'react'
import { t } from '@shared/i18n'
import { keybindDisplay } from '@shared/keybinds'
import { cn, Keys, Tooltip } from '../../components/ui'
import { useSettings } from '../../stores/settings'
import { askQuestion, submitDraft } from '../actions'
import { useUi } from '../stores/uiStore'
import { OverlayMenu } from './OverlayMenu'

/** A focus request older than this is ignored when the input (re)mounts. */
const FOCUS_REQUEST_TTL_MS = 1500

/** Tallest the input grows before it scrolls (about four lines). */
const MAX_INPUT_HEIGHT = 92

/** "Smart" / "Fast" chip: which model answers Assist and typed questions. */
function TierChip() {
  const tier = useSettings((s) => s.settings.models.activeTier)
  const smart = tier === 'smart'
  const toggle = () => {
    useSettings
      .getState()
      .update({ models: { activeTier: smart ? 'fast' : 'smart' } })
      .catch(() => undefined)
  }
  return (
    <Tooltip content={smart ? t('overlay.input.tierSmart') : t('overlay.input.tierFast')}>
      <button
        type="button"
        onClick={toggle}
        data-tier={tier}
        className={cn(
          'no-drag inline-flex h-6 items-center gap-1 rounded-md px-2 text-[12px] font-semibold transition-colors duration-150',
          smart
            ? 'bg-accent-soft text-accent-text hover:bg-accent/25'
            : 'bg-warning-soft text-warning hover:bg-warning/25',
        )}
      >
        {smart ? <Sparkles size={12} /> : <Zap size={12} />}
        {smart ? t('common.smart') : t('common.fast')}
      </button>
    </Tooltip>
  )
}

/** Eye toggle: include the screen. It edits whichever setting applies to the current input. */
function ScreenToggle({ forQuestion }: { forQuestion: boolean }) {
  const on = useUi((s) => (forQuestion ? s.screenForQuestions : s.screenForAssist))
  const tip = forQuestion
    ? on
      ? t('overlay.input.screenOnQuestion')
      : t('overlay.input.screenOffQuestion')
    : on
      ? t('overlay.input.screenOnAssist')
      : t('overlay.input.screenOffAssist')
  return (
    <Tooltip content={tip}>
      <button
        type="button"
        aria-label={tip}
        aria-pressed={on}
        data-screen={on ? 'on' : 'off'}
        onClick={() => useUi.getState().toggleScreen(forQuestion ? 'question' : 'assist')}
        className={cn(
          'no-drag inline-flex h-8 w-8 items-center justify-center rounded-full transition-colors duration-150 hover:bg-panel-3',
          on ? 'text-accent-text' : 'text-subtle hover:text-muted',
        )}
      >
        {on ? <Eye size={16} /> : <EyeOff size={16} />}
      </button>
    </Tooltip>
  )
}

/**
 * The ask box: auto-growing input with a keycap placeholder, then a toolbar with the tier
 * chip, the "…" menu, the include-screen eye and the send button.
 */
export function AskInput() {
  const draft = useUi((s) => s.draft)
  const focusRequest = useUi((s) => s.focusRequest)
  const assistAcc = useSettings((s) => s.settings.keybinds.askAssist)
  const ref = useRef<HTMLTextAreaElement>(null)
  const hasText = draft.trim().length > 0
  const keys = keybindDisplay('askAssist', assistAcc)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${Math.min(el.scrollHeight, MAX_INPUT_HEIGHT)}px`
  }, [draft])

  useEffect(() => {
    if (focusRequest > 0 && Date.now() - focusRequest < FOCUS_REQUEST_TTL_MS) ref.current?.focus()
  }, [focusRequest])

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends, Shift+Enter adds a line. Ctrl+Enter (Assist) is handled globally.
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      if (e.nativeEvent.isComposing) return
      e.preventDefault()
      if (hasText) {
        const question = draft
        useUi.getState().setDraft('')
        void askQuestion(question)
      }
    }
  }

  return (
    <div className="rounded-xl border border-line-strong bg-ov-input transition-colors duration-150 focus-within:border-accent/60">
      <div className="relative px-3 pt-2.5 pb-1">
        <textarea
          ref={ref}
          rows={1}
          value={draft}
          aria-label={t('overlay.input.label')}
          spellCheck
          onChange={(e) => useUi.getState().setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          className="no-drag selectable block max-h-[92px] w-full resize-none bg-transparent text-[13.5px] leading-5 text-fg outline-none focus-visible:outline-none"
        />
        {draft === '' ? (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-3 top-2.5 flex h-5 items-center gap-1.5 truncate text-[13.5px] text-subtle"
          >
            {keys.length ? (
              <>
                <span className="truncate">{t('overlay.input.placeholderBefore')}</span>
                <Keys keys={keys} className="shrink-0 [&>kbd]:h-[18px] [&>kbd]:text-[10.5px]" />
                <span className="shrink-0">{t('overlay.input.placeholderAfter')}</span>
              </>
            ) : (
              <span className="truncate">{t('overlay.input.label')}</span>
            )}
          </div>
        ) : null}
      </div>
      <div className="flex items-center gap-1 px-2 pb-2">
        <TierChip />
        <OverlayMenu />
        <div className="flex-1" />
        <ScreenToggle forQuestion={hasText} />
        <Tooltip content={hasText ? t('overlay.input.send') : t('overlay.input.assist')}>
          <button
            type="button"
            aria-label={hasText ? t('overlay.input.send') : t('overlay.input.assist')}
            onClick={() => void submitDraft()}
            className="no-drag bluely-gradient inline-flex h-8 w-8 items-center justify-center rounded-full text-white shadow-[0_2px_10px_var(--accent-glow)] transition-[filter,transform] duration-150 hover:brightness-110 active:scale-95"
          >
            <ArrowUp size={16} strokeWidth={2.4} />
          </button>
        </Tooltip>
      </div>
    </div>
  )
}
