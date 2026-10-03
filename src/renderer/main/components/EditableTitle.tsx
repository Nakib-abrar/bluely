import { useRef, useState, type Ref } from 'react'
import { Pencil } from 'lucide-react'
import { t } from '@shared/i18n'

export interface EditableTitleProps {
  title: string
  /** Called with the trimmed new title; only when it actually changed. */
  onRename(next: string): void
  /** The page heading; the meeting page moves focus here when it opens. */
  headingRef?: Ref<HTMLHeadingElement>
}

/**
 * Meeting title that turns into an input on click. Enter saves, Esc cancels.
 * Keep it mounted across title updates: the stored title can change in the background (notes
 * finishing name an untitled meeting) and must not discard what is being typed. While editing,
 * the input only shows the draft; `title` is read again when the edit starts or is committed.
 */
export function EditableTitle({ title, onRename, headingRef }: EditableTitleProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(title)
  const cancelled = useRef(false)

  const commit = () => {
    setEditing(false)
    if (cancelled.current) return
    const next = draft.trim().slice(0, 200)
    if (next && next !== title) onRename(next)
  }

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        maxLength={200}
        aria-label={t('session.title.label')}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            e.currentTarget.blur()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            cancelled.current = true
            e.currentTarget.blur()
          }
        }}
        className="-mx-2 h-10 w-[calc(100%+16px)] rounded-lg border border-accent/70 bg-panel-2 px-2 text-[22px] font-semibold tracking-[-0.015em] text-fg shadow-[0_0_0_3px_var(--accent-soft)] outline-none"
        data-testid="title-input"
      />
    )
  }

  return (
    <h1 ref={headingRef} tabIndex={-1} className="-mx-2 min-w-0 outline-none">
      <button
        type="button"
        title={t('session.title.edit')}
        onClick={() => {
          cancelled.current = false
          setDraft(title)
          setEditing(true)
        }}
        className="group flex h-10 max-w-full items-center gap-2 rounded-lg px-2 text-left transition-colors hover:bg-panel-2"
      >
        <span className="truncate text-[22px] font-semibold tracking-[-0.015em] text-fg">
          {title}
        </span>
        <Pencil
          size={14}
          aria-hidden="true"
          className="shrink-0 text-subtle opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
        />
      </button>
    </h1>
  )
}
