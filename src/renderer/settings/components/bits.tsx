/**
 * Small presentational pieces shared by the settings pages and onboarding.
 */
import { Check, CircleCheck, CircleX, ExternalLink, Info } from 'lucide-react'
import { Slider as RadixSlider } from 'radix-ui'
import type { ReactNode } from 'react'
import { t } from '@shared/i18n'
import { cn, Spinner } from '../../components/ui'
import { invoke } from '../../lib/ipc'
import { levelToMeter } from '../lib/wav'

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
}) {
  return (
    <header className="mb-5 flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h2 className="text-[17px] font-semibold tracking-[-0.01em] text-fg">{title}</h2>
        {subtitle ? <p className="mt-0.5 text-[13px] text-muted">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  )
}

/** Like SettingsSection, with optional actions aligned to the right of the heading. */
export function Section({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn('mt-6 first:mt-0', className)}>
      <div className="flex items-end justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-[15px] font-semibold text-fg">{title}</h3>
          {description ? <p className="mt-0.5 text-[12.5px] text-muted">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      <div className="mt-2">{children}</div>
    </section>
  )
}

export type StatusTone = 'success' | 'error' | 'info' | 'pending'

/** One-line result such as "✓ Connected · $16.79 remaining" or "✗ No sound detected". */
export function StatusLine({
  tone,
  children,
  className,
}: {
  tone: StatusTone
  children: ReactNode
  className?: string
}) {
  const icon =
    tone === 'success' ? (
      <CircleCheck size={15} className="text-success" />
    ) : tone === 'error' ? (
      <CircleX size={15} className="text-danger" />
    ) : tone === 'pending' ? (
      <Spinner size={14} className="text-accent-text" />
    ) : (
      <Info size={15} className="text-accent-text" />
    )
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'flex animate-fade-in items-start gap-2 text-[12.5px] leading-[1.45]',
        tone === 'error' ? 'text-danger' : tone === 'success' ? 'text-fg' : 'text-muted',
        className,
      )}
    >
      <span className="mt-[1px] shrink-0">{icon}</span>
      <span className="selectable min-w-0 break-words">{children}</span>
    </div>
  )
}

/** "Saving… / ✓ Saved" pill for autosaving forms. */
export function SaveIndicator({ state }: { state: 'idle' | 'saving' | 'saved' | 'error' }) {
  if (state === 'idle') return null
  return (
    <span
      aria-live="polite"
      className={cn(
        'inline-flex animate-fade-in items-center gap-1 text-[12px]',
        state === 'error' ? 'text-danger' : 'text-subtle',
      )}
    >
      {state === 'saving' ? <Spinner size={11} /> : state === 'saved' ? <Check size={12} /> : null}
      {state === 'saving' ? t('settings.saving') : state === 'saved' ? t('settings.saved') : null}
    </span>
  )
}

/** Accent link that opens an allowlisted URL in the default browser. */
export function ExternalLinkButton({
  href,
  children,
  className,
}: {
  href: string
  children: ReactNode
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={() => void invoke('app:openExternal', { url: href }).catch(() => undefined)}
      className={cn(
        'no-drag inline-flex items-center gap-1 rounded-md text-[13px] font-medium text-accent-text hover:underline',
        className,
      )}
    >
      {children}
      <ExternalLink size={13} aria-hidden="true" />
    </button>
  )
}

/** Horizontal input-level meter (RMS on a dB scale). */
export function LevelMeter({ level, className }: { level: number; className?: string }) {
  const pct = Math.round(levelToMeter(level) * 100)
  return (
    <div
      role="meter"
      aria-label={t('settings.audio.mic.level')}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      className={cn('h-2 w-full overflow-hidden rounded-full bg-panel-4', className)}
    >
      <div
        className="bluely-gradient h-full rounded-full transition-[width] duration-75 ease-out"
        style={{ width: `${Math.max(2, pct)}%` }}
      />
    </div>
  )
}

export function Slider({
  value,
  min,
  max,
  step,
  label,
  onValueChange,
  onValueCommit,
  className,
}: {
  value: number
  min: number
  max: number
  step: number
  label: string
  onValueChange: (value: number) => void
  onValueCommit: (value: number) => void
  className?: string
}) {
  return (
    <RadixSlider.Root
      value={[value]}
      min={min}
      max={max}
      step={step}
      onValueChange={(v) => onValueChange(v[0] ?? value)}
      onValueCommit={(v) => onValueCommit(v[0] ?? value)}
      className={cn(
        'no-drag relative flex h-5 w-full touch-none items-center select-none',
        className,
      )}
    >
      <RadixSlider.Track className="relative h-1.5 grow overflow-hidden rounded-full bg-panel-4">
        <RadixSlider.Range className="bluely-gradient absolute h-full rounded-full" />
      </RadixSlider.Track>
      <RadixSlider.Thumb
        aria-label={label}
        className="block h-4 w-4 rounded-full border border-line-strong bg-white shadow-soft transition-transform duration-150 hover:scale-110"
      />
    </RadixSlider.Root>
  )
}

/** Uppercase-free small heading used inside cards ("Provider routing", …). */
export function FieldLabel({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 block text-[12px] font-medium text-muted">
      {children}
    </label>
  )
}

/** Thin divider used between rows inside a card. */
export function Divider({ className }: { className?: string }) {
  return <div className={cn('h-px bg-line', className)} />
}
