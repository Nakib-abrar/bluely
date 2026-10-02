import { forwardRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import { t } from '@shared/i18n'
import { cn, Spinner } from '../../components/ui'
import { focusFirstResult } from '../lib/focus'

export interface SearchBoxProps {
  value: string
  onChange(value: string): void
  /** Enter: ask Bluely (question) or open the first result. */
  onSubmit(): void
  loading: boolean
  className?: string
}

/**
 * Title-bar search. Idle it shows a centered hint like a native caption search; focused it
 * becomes a normal left-aligned field. Esc clears, ↓ moves into the results.
 */
export const SearchBox = forwardRef<HTMLInputElement, SearchBoxProps>(function SearchBox(
  { value, onChange, onSubmit, loading, className },
  ref,
) {
  const [focused, setFocused] = useState(false)
  const idle = !value && !focused
  const placeholder = t('home.titleBar.searchPlaceholder')

  return (
    <div
      className={cn(
        'no-drag relative flex h-8 items-center gap-2 rounded-[9px] border bg-panel-3 px-2.5 text-[13px] transition-[border-color,background-color,box-shadow] duration-150',
        focused
          ? 'border-accent/70 bg-panel-2 shadow-[0_0_0_3px_var(--accent-soft)]'
          : 'border-line hover:border-line-strong',
        className,
      )}
    >
      {idle ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 text-subtle"
        >
          <Search size={13.5} />
          <span>{placeholder}</span>
        </div>
      ) : (
        <Search size={13.5} className="shrink-0 text-subtle" aria-hidden="true" />
      )}
      <input
        ref={ref}
        type="search"
        value={value}
        spellCheck={false}
        autoComplete="off"
        aria-label={t('home.titleBar.searchLabel')}
        placeholder={idle ? '' : placeholder}
        className="h-full min-w-0 flex-1 bg-transparent text-fg outline-none placeholder:text-subtle focus-visible:outline-none [&::-webkit-search-cancel-button]:hidden"
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            if (value) onChange('')
            else e.currentTarget.blur()
          } else if (e.key === 'ArrowDown') {
            if (focusFirstResult()) e.preventDefault()
          } else if (e.key === 'Enter') {
            e.preventDefault()
            onSubmit()
          }
        }}
      />
      {loading && value ? <Spinner size={13} className="shrink-0 text-subtle" /> : null}
      {value ? (
        <button
          type="button"
          aria-label={t('home.titleBar.clearSearch')}
          className="-mr-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-subtle hover:bg-panel-4 hover:text-fg"
          onClick={() => onChange('')}
        >
          <X size={13} />
        </button>
      ) : idle ? (
        <kbd
          aria-hidden="true"
          className="pointer-events-none absolute right-2 inline-flex h-[18px] items-center rounded-[5px] border border-line px-1.5 font-sans text-[10.5px] font-medium text-subtle"
        >
          {t('home.titleBar.searchShortcut')}
        </kbd>
      ) : null}
    </div>
  )
})
