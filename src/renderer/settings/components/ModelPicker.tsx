/**
 * Searchable model combobox (Popover + filter input + capped list) over the OpenRouter catalog.
 * Each option shows name, id, context length, price and capability badges.
 */
import { Check, ChevronDown, RefreshCw, Search } from 'lucide-react'
import { Popover } from 'radix-ui'
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { t } from '@shared/i18n'
import type { ModelInfo } from '@shared/types'
import { Badge, Button, cn, Spinner } from '../../components/ui'
import {
  filterModelsForRole,
  modelLabel,
  modelMeta,
  searchModels,
  type PickerRole,
} from '../lib/models'
import { useModelCatalog } from '../stores'

/** Rendering thousands of rows is slow and useless; search narrows instead. */
const MAX_VISIBLE = 150
const DEFAULT_VALUE = ''

export interface ModelPickerProps {
  role: PickerRole
  /** Selected model id; '' means "use default" when `defaultLabel` is given. */
  value: string
  onChange: (id: string) => void
  /** Accessible name of the trigger. */
  label: string
  /** When set, the first option is "Use default (…)", stored as ''. */
  defaultLabel?: string
  /** Ids to hide (e.g. models already in the latency test). */
  exclude?: readonly string[]
  /** Custom trigger content (button styled by the picker). */
  triggerContent?: ReactNode
  className?: string
  disabled?: boolean
}

type Option = { kind: 'default' } | { kind: 'model'; model: ModelInfo }

export function ModelBadges({ model }: { model: ModelInfo }) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      {model.supportsVision ? <Badge tone="accent">{t('settings.picker.vision')}</Badge> : null}
      {model.supportsAudioInput && !model.isStt ? (
        <Badge tone="success">{t('settings.picker.audio')}</Badge>
      ) : null}
      {model.isStt ? <Badge tone="warning">{t('settings.picker.stt')}</Badge> : null}
    </span>
  )
}

export function ModelPicker({
  role,
  value,
  onChange,
  label,
  defaultLabel,
  exclude,
  triggerContent,
  className,
  disabled,
}: ModelPickerProps) {
  const { models, status, error, load } = useModelCatalog()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listId = useId()

  useEffect(() => {
    if (status === 'idle') void load()
  }, [status, load])

  const candidates = useMemo(() => {
    const fit = filterModelsForRole(models, role)
    return exclude?.length ? fit.filter((m) => !exclude.includes(m.id)) : fit
  }, [models, role, exclude])
  const matches = useMemo(() => searchModels(candidates, query), [candidates, query])
  const options = useMemo<Option[]>(() => {
    const list: Option[] = matches.slice(0, MAX_VISIBLE).map((model) => ({ kind: 'model', model }))
    return defaultLabel && !query.trim() ? [{ kind: 'default' }, ...list] : list
  }, [matches, defaultLabel, query])

  const openPicker = (next: boolean) => {
    setOpen(next)
    if (next) {
      setQuery('')
      const selectedIdx = value
        ? candidates.findIndex((m) => m.id === value) + (defaultLabel ? 1 : 0)
        : 0
      setHighlight(Math.max(0, Math.min(selectedIdx, MAX_VISIBLE)))
    }
  }

  // Keep the highlighted option visible while navigating with the keyboard.
  useEffect(() => {
    if (!open) return
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${highlight}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [highlight, open])

  const choose = (opt: Option | undefined) => {
    if (!opt) return
    onChange(opt.kind === 'default' ? DEFAULT_VALUE : opt.model.id)
    setOpen(false)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlight((h) => Math.min(options.length - 1, h + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((h) => Math.max(0, h - 1))
    } else if (e.key === 'Home') {
      e.preventDefault()
      setHighlight(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      setHighlight(Math.max(0, options.length - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      choose(options[highlight])
    }
  }

  const selectedName = value
    ? modelLabel(models, value)
    : (defaultLabel ?? t('settings.picker.placeholder'))

  return (
    <Popover.Root open={open} onOpenChange={openPicker} modal>
      <Popover.Trigger asChild disabled={disabled}>
        <button
          type="button"
          aria-label={label}
          title={value || undefined}
          className={cn(
            'no-drag inline-flex h-9 items-center justify-between gap-2 rounded-[10px] border border-line bg-panel-2 px-3 text-left text-[13.5px] text-fg transition-colors hover:bg-panel-3 disabled:opacity-50 data-[state=open]:border-accent',
            className,
          )}
        >
          {triggerContent ?? (
            <>
              <span className={cn('min-w-0 truncate', !value && defaultLabel && 'text-muted')}>
                {selectedName}
              </span>
              <ChevronDown size={15} className="shrink-0 text-muted" aria-hidden="true" />
            </>
          )}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          collisionPadding={12}
          onOpenAutoFocus={(e) => {
            // Focus the search box, not the first option.
            e.preventDefault()
            inputRef.current?.focus()
          }}
          className="z-50 flex max-h-[min(420px,var(--radix-popover-content-available-height))] w-[min(460px,calc(100vw-32px))] flex-col overflow-hidden rounded-xl border border-line bg-panel-2 shadow-panel animate-fade-in"
        >
          <div className="flex items-center gap-2 border-b border-line px-3">
            <Search size={14} className="shrink-0 text-subtle" aria-hidden="true" />
            <input
              ref={inputRef}
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={options[highlight] ? `${listId}-${highlight}` : undefined}
              aria-label={t('settings.picker.search')}
              placeholder={t('settings.picker.search')}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setHighlight(0)
              }}
              onKeyDown={onKeyDown}
              className="h-10 min-w-0 flex-1 bg-transparent text-[13.5px] text-fg outline-none placeholder:text-subtle focus-visible:outline-none"
            />
            {status === 'loading' ? <Spinner size={13} className="text-subtle" /> : null}
          </div>
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label={label}
            className="min-h-0 flex-1 overflow-y-auto p-1"
          >
            {options.map((opt, i) => {
              const selected = opt.kind === 'default' ? !value : opt.model.id === value
              return (
                <div
                  key={opt.kind === 'default' ? '__default' : opt.model.id}
                  id={`${listId}-${i}`}
                  data-index={i}
                  role="option"
                  aria-selected={selected}
                  onMouseMove={() => setHighlight(i)}
                  onClick={() => choose(opt)}
                  className={cn(
                    'flex cursor-default items-start gap-2 rounded-lg px-2 py-2',
                    i === highlight && 'bg-panel-3',
                  )}
                >
                  <span className="mt-0.5 w-4 shrink-0">
                    {selected ? <Check size={14} className="text-accent-text" /> : null}
                  </span>
                  {opt.kind === 'default' ? (
                    <span className="text-[13px] text-fg">{defaultLabel}</span>
                  ) : (
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg">
                          {opt.model.name}
                        </span>
                        <ModelBadges model={opt.model} />
                      </span>
                      <span className="tabular mt-0.5 block truncate text-[11.5px] text-subtle">
                        {modelMeta(opt.model)}
                      </span>
                    </span>
                  )}
                </div>
              )
            })}
            <PickerFooter
              status={status}
              error={error}
              query={query}
              shown={Math.min(matches.length, MAX_VISIBLE)}
              total={matches.length}
              hasCandidates={candidates.length > 0}
              onRetry={() => void load({ refresh: true })}
            />
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

function PickerFooter({
  status,
  error,
  query,
  shown,
  total,
  hasCandidates,
  onRetry,
}: {
  status: string
  error: string | null
  query: string
  shown: number
  total: number
  hasCandidates: boolean
  onRetry: () => void
}) {
  if (status === 'error') {
    return (
      <div className="flex items-center justify-between gap-3 px-3 py-3 text-[12.5px] text-danger">
        <span className="min-w-0">{t('settings.picker.error', { error: error ?? '' })}</span>
        <Button size="sm" variant="secondary" icon={<RefreshCw size={13} />} onClick={onRetry}>
          {t('settings.picker.retry')}
        </Button>
      </div>
    )
  }
  if (status === 'loading' && !hasCandidates) {
    return (
      <div className="flex items-center gap-2 px-3 py-3 text-[12.5px] text-muted">
        <Spinner size={13} /> {t('settings.picker.loading')}
      </div>
    )
  }
  if (total === 0) {
    return (
      <div className="px-3 py-3 text-[12.5px] text-muted">
        {query.trim() ? t('settings.picker.empty', { query }) : t('settings.picker.emptyRole')}
      </div>
    )
  }
  if (shown < total) {
    return (
      <div className="px-3 py-2 text-[11.5px] text-subtle">
        {t('settings.picker.more', { shown, total })}
      </div>
    )
  }
  return null
}
