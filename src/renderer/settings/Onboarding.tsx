/**
 * First-run onboarding: 1) OpenRouter key, 2) audio check + Ask shortcut, 3) pick a Mode.
 * Fills its container (render it inside the main window frame, below the title bar).
 */
import { ArrowLeft, ArrowRight, Check, Keyboard, Play } from 'lucide-react'
import { useEffect, useState } from 'react'
import { BUILTIN_MODES } from '@shared/builtinModes'
import { t } from '@shared/i18n'
import {
  ALT_ENTER_PRESET,
  getKeybindDef,
  keybindDisplay,
  normalizeAccelerator,
} from '@shared/keybinds'
import type { Mode } from '@shared/types'
import { Button, Card, cn, Input, Keys, LogoMark } from '../components/ui'
import { invoke } from '../lib/ipc'
import { useSettings } from '../stores/settings'
import { AudioSetupCard } from './components/AudioSetup'
import { StatusLine } from './components/bits'
import { KeyBlock } from './components/KeyBlock'
import { KnowledgeFiles } from './components/KnowledgeFiles'
import { describeError } from './lib/errors'
import { describeRebindOutcome, evaluateRebind } from './lib/rebind'
import { useActiveModeId, useModes } from './stores'

export interface OnboardingProps {
  onDone(): void
}

const STEPS = ['key', 'audio', 'mode'] as const
type Step = (typeof STEPS)[number]

function Stepper({ current }: { current: number }) {
  return (
    <ol
      aria-label={t('onboarding.progressLabel')}
      className="mx-auto mt-6 flex w-full max-w-[460px] items-center"
    >
      {STEPS.map((step, i) => {
        const done = i < current
        const active = i === current
        return (
          <li
            key={step}
            aria-current={active ? 'step' : undefined}
            className={cn('flex items-center', i < STEPS.length - 1 && 'flex-1')}
          >
            <div className="flex flex-col items-center gap-1.5">
              <span
                className={cn(
                  'flex h-8 w-8 items-center justify-center rounded-full text-[13px] font-semibold transition-colors duration-200',
                  active && 'bluely-gradient bluely-glow text-white',
                  done && 'bg-accent-soft text-accent-text',
                  !active && !done && 'border border-line bg-panel-2 text-subtle',
                )}
              >
                {done ? <Check size={15} strokeWidth={2.5} /> : i + 1}
              </span>
              <span
                className={cn(
                  'text-[12px] whitespace-nowrap',
                  active ? 'font-medium text-fg' : 'text-subtle',
                )}
              >
                {t(`onboarding.steps.${step}`)}
              </span>
            </div>
            {i < STEPS.length - 1 ? (
              <span
                aria-hidden="true"
                className={cn(
                  'mx-2 mb-5 h-px flex-1 transition-colors duration-200',
                  done ? 'bg-accent/60' : 'bg-line-strong',
                )}
              />
            ) : null}
          </li>
        )
      })}
    </ol>
  )
}

function StepTitle({ title, body }: { title: string; body: string }) {
  return (
    <div className="mb-5">
      <h2 className="text-[18px] font-semibold tracking-[-0.01em] text-fg">{title}</h2>
      <p className="mt-1 text-[13.5px] leading-relaxed text-muted">{body}</p>
    </div>
  )
}

function KeyStep({ keyOk, onTested }: { keyOk: boolean; onTested: (ok: boolean) => void }) {
  return (
    <div>
      <StepTitle title={t('onboarding.key.title')} body={t('onboarding.key.body')} />
      <KeyBlock onTestResult={onTested} autoFocus />
      <p className="mt-3 text-[12.5px] text-subtle">
        {keyOk ? t('onboarding.key.ready') : t('onboarding.key.testFirst')}
      </p>
    </div>
  )
}

function AudioStep() {
  const keybinds = useSettings((s) => s.settings.keybinds)
  const update = useSettings((s) => s.update)
  const [error, setError] = useState<string | null>(null)
  const preset = ALT_ENTER_PRESET.askAssist ?? 'Alt+Enter'
  const applied =
    keybinds.askAssist != null &&
    normalizeAccelerator(keybinds.askAssist) === normalizeAccelerator(preset)

  const applyPreset = async () => {
    const outcome = evaluateRebind(keybinds, 'askAssist', preset)
    if (outcome.kind !== 'ok' && outcome.kind !== 'focusOnly') {
      setError(describeRebindOutcome(getKeybindDef('askAssist'), outcome)?.text ?? null)
      return
    }
    try {
      await update({ keybinds: { askAssist: outcome.accelerator } })
      setError(null)
    } catch (err) {
      setError(describeError(err))
    }
  }

  return (
    <div>
      <StepTitle title={t('onboarding.audio.title')} body={t('onboarding.audio.body')} />
      <AudioSetupCard />
      <div data-testid="onboarding-ask-preset">
        <Card className="mt-4 flex items-center gap-3.5">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] border border-line bg-panel-3 text-muted">
            <Keyboard size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-medium text-fg">{t('onboarding.audio.askTitle')}</div>
            <div className="mt-0.5 text-[12.5px] leading-relaxed text-muted">
              {applied
                ? t('onboarding.audio.askBodyApplied')
                : t('onboarding.audio.askBody', {
                    keys: keybindDisplay(
                      'askAssist',
                      keybinds.askAssist ?? 'CommandOrControl+Enter',
                    )
                      .join('+')
                      .replace('↵', 'Enter'),
                  })}
            </div>
          </div>
          {applied ? (
            <span className="inline-flex shrink-0 items-center gap-1.5 text-[12.5px] font-medium text-success">
              <Check size={14} /> {t('onboarding.audio.askApplied')}
            </span>
          ) : (
            <Button className="shrink-0" onClick={() => void applyPreset()}>
              <Keys keys={['Alt', '↵']} />
              {t('onboarding.audio.askApply')}
            </Button>
          )}
        </Card>
      </div>
      {error ? (
        <StatusLine tone="error" className="mt-2">
          {error}
        </StatusLine>
      ) : null}
    </div>
  )
}

function ModeCard({
  mode,
  selected,
  onSelect,
}: {
  mode: Mode
  selected: boolean
  onSelect: () => void
}) {
  const firstSentence = mode.instructions.split(/(?<=\.)\s/)[0] ?? ''
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        'no-drag relative flex h-full flex-col items-start rounded-xl border p-3 text-left transition-[border-color,background-color,box-shadow] duration-150',
        selected
          ? 'border-accent bg-accent-soft shadow-[0_0_0_1px_var(--accent)]'
          : 'border-line bg-panel-2 hover:border-line-strong hover:bg-panel-3',
      )}
    >
      <span className="text-[22px] leading-none" aria-hidden="true">
        {mode.icon || '•'}
      </span>
      <span className="mt-2 text-[13.5px] font-medium text-fg">{mode.name}</span>
      <span className="mt-1 line-clamp-2 text-[12px] leading-snug text-muted">{firstSentence}</span>
      {selected ? (
        <span className="absolute top-2.5 right-2.5 flex h-5 w-5 items-center justify-center rounded-full bg-accent text-white">
          <Check size={12} strokeWidth={3} />
        </span>
      ) : null}
    </button>
  )
}

function ModeStep({ name, onName }: { name: string; onName: (v: string) => void }) {
  const { modes, status, error, load, setActive } = useModes()
  const selectedId = useActiveModeId()
  const [setError, setSetError] = useState<string | null>(null)

  useEffect(() => {
    void load()
  }, [load])

  const list = modes.length ? modes : status === 'error' ? BUILTIN_MODES : []
  const selected = list.find((m) => m.id === selectedId) ?? null

  const choose = (id: string) => {
    setSetError(null)
    setActive(id).catch((err: unknown) => setSetError(describeError(err)))
  }

  return (
    <div>
      <StepTitle title={t('onboarding.mode.title')} body={t('onboarding.mode.body')} />
      {status === 'error' ? (
        <StatusLine tone="error" className="mb-3">
          {t('onboarding.mode.loadError', { error: error ?? '' })}
        </StatusLine>
      ) : null}
      <div
        role="radiogroup"
        aria-label={t('onboarding.mode.title')}
        className="grid grid-cols-3 gap-2.5"
        data-testid="onboarding-modes"
      >
        {list.map((m) => (
          <ModeCard
            key={m.id}
            mode={m}
            selected={m.id === selectedId}
            onSelect={() => choose(m.id)}
          />
        ))}
      </div>
      {setError ? (
        <StatusLine tone="error" className="mt-2">
          {setError}
        </StatusLine>
      ) : null}

      {selected && modes.length ? (
        <div className="mt-6">
          <div className="text-[14px] font-medium text-fg">
            {t('onboarding.mode.filesTitle', { mode: selected.name })}
          </div>
          <div className="mt-0.5 mb-2.5 text-[12.5px] text-muted">
            {t('onboarding.mode.filesOptional')}
          </div>
          <KnowledgeFiles key={selected.id} modeId={selected.id} compact />
        </div>
      ) : null}

      <div className="mt-6">
        <label htmlFor="onboarding-name" className="text-[14px] font-medium text-fg">
          {t('onboarding.mode.nameTitle')}
        </label>
        <div className="mt-0.5 mb-2.5 text-[12.5px] text-muted">
          {t('onboarding.mode.nameOptional')}
        </div>
        <Input
          id="onboarding-name"
          value={name}
          maxLength={200}
          autoComplete="name"
          placeholder={t('onboarding.mode.namePlaceholder')}
          onChange={(e) => onName(e.target.value)}
          className="max-w-[320px]"
        />
      </div>
    </div>
  )
}

export function Onboarding({ onDone }: OnboardingProps) {
  const update = useSettings((s) => s.update)
  const savedName = useSettings((s) => s.settings.profile.name)
  const [stepIndex, setStepIndex] = useState(0)
  const [keyOk, setKeyOk] = useState(false)
  const [name, setName] = useState(savedName)
  const [finishing, setFinishing] = useState<'finish' | 'start' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const step: Step = STEPS[stepIndex] ?? 'key'
  const last = stepIndex === STEPS.length - 1

  const finish = async (startSession: boolean) => {
    setFinishing(startSession ? 'start' : 'finish')
    setError(null)
    try {
      const trimmed = name.trim()
      await update({
        general: { onboardingComplete: true },
        ...(trimmed !== savedName ? { profile: { name: trimmed } } : {}),
      })
    } catch (err) {
      setError(describeError(err))
      setFinishing(null)
      return
    }
    if (startSession) {
      try {
        await invoke('session:start', {})
      } catch (err) {
        // Setup is complete either way; the main window shows the session error state.
        void invoke('app:rendererLog', {
          level: 'warn',
          message: t('onboarding.startFailed', { error: describeError(err) }),
        }).catch(() => undefined)
      }
    }
    setFinishing(null)
    onDone()
  }

  return (
    <div className="relative h-full overflow-y-auto bg-bg" data-testid="onboarding">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[360px] bg-[radial-gradient(ellipse_at_top,var(--accent-soft),transparent_70%)]"
      />
      <div className="relative mx-auto flex min-h-full w-full max-w-[680px] flex-col px-6 pt-8">
        <header className="flex flex-col items-center text-center">
          <LogoMark size={42} />
          <h1 className="mt-3 text-[24px] font-semibold tracking-[-0.02em] text-fg">
            {t('onboarding.welcome')}
          </h1>
          <p className="mt-1 text-[14px] text-muted">{t('onboarding.intro')}</p>
        </header>

        <Stepper current={stepIndex} />

        <section
          key={step}
          aria-label={t('onboarding.stepOf', { n: stepIndex + 1, total: STEPS.length })}
          className="mt-6 mb-1 animate-fade-in rounded-2xl border border-line bg-panel p-6 shadow-panel"
          data-testid={`onboarding-step-${step}`}
        >
          {step === 'key' ? (
            <KeyStep keyOk={keyOk} onTested={setKeyOk} />
          ) : step === 'audio' ? (
            <AudioStep />
          ) : (
            <ModeStep name={name} onName={setName} />
          )}
        </section>

        {error ? (
          <StatusLine tone="error" className="mt-3">
            {error}
          </StatusLine>
        ) : null}

        {/* Sticky so Back/Next stay reachable on small windows while the step scrolls. */}
        <footer className="sticky bottom-0 z-10 -mx-6 mt-auto flex items-center gap-2 bg-bg/90 px-6 pt-5 pb-6 backdrop-blur-sm">
          {stepIndex > 0 ? (
            <Button
              variant="ghost"
              icon={<ArrowLeft size={15} />}
              onClick={() => setStepIndex((i) => Math.max(0, i - 1))}
            >
              {t('common.back')}
            </Button>
          ) : null}
          <span className="tabular ml-1 text-[12px] text-subtle">
            {t('onboarding.stepOf', { n: stepIndex + 1, total: STEPS.length })}
          </span>
          <div className="flex-1" />
          {last ? (
            <>
              <Button
                loading={finishing === 'finish'}
                disabled={finishing != null}
                onClick={() => void finish(false)}
              >
                {t('onboarding.finish')}
              </Button>
              <Button
                variant="primary"
                size="lg"
                icon={<Play size={15} fill="currentColor" />}
                loading={finishing === 'start'}
                disabled={finishing != null}
                onClick={() => void finish(true)}
              >
                {t('onboarding.start')}
              </Button>
            </>
          ) : (
            <>
              {step === 'key' && !keyOk ? (
                <Button variant="ghost" onClick={() => setStepIndex((i) => i + 1)}>
                  {t('onboarding.skip')}
                </Button>
              ) : null}
              <Button
                variant="primary"
                iconRight={<ArrowRight size={15} />}
                disabled={step === 'key' && !keyOk}
                onClick={() => setStepIndex((i) => Math.min(STEPS.length - 1, i + 1))}
              >
                {t('common.next')}
              </Button>
            </>
          )}
        </footer>
      </div>
    </div>
  )
}
