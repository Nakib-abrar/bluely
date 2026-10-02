import { ArrowDown } from 'lucide-react'
import { t } from '@shared/i18n'

/** Floating pill shown when the user scrolled away from the newest content. */
export function JumpToLatest({ onClick }: { onClick: () => void }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center">
      <button
        type="button"
        onClick={onClick}
        className="no-drag pointer-events-auto inline-flex h-7 animate-fade-in items-center gap-1.5 rounded-full border border-line-strong bg-panel-2 px-3 text-[12px] font-medium text-fg shadow-panel hover:bg-panel-3"
      >
        <ArrowDown size={13} />
        {t('overlay.list.jumpToLatest')}
      </button>
    </div>
  )
}
