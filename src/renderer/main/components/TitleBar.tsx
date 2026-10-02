import { forwardRef } from 'react'
import { ArrowLeft, UserRound } from 'lucide-react'
import { t } from '@shared/i18n'
import { IconButton, Tooltip } from '../../components/ui'
import { useSettings } from '../../stores/settings'
import { profileInitial } from '../lib/text'
import { useNav } from '../router'
import { SearchBox } from './SearchBox'
import { WindowControls } from './WindowControls'

export interface TitleBarProps {
  query: string
  onQueryChange(query: string): void
  onSubmit(): void
  searching: boolean
  canGoBack: boolean
  onBack(): void
}

/** Frameless window caption: back, centered search, profile/settings, window controls. */
export const TitleBar = forwardRef<HTMLInputElement, TitleBarProps>(function TitleBar(
  { query, onQueryChange, onSubmit, searching, canGoBack, onBack },
  searchRef,
) {
  const nav = useNav()
  const name = useSettings((s) => s.settings.profile.name)
  const initial = profileInitial(name)
  const avatarLabel = name.trim()
    ? t('home.titleBar.profileSettings', { name: name.trim() })
    : t('home.titleBar.settings')

  return (
    <header className="drag relative flex h-11 shrink-0 items-center bg-panel pl-1.5">
      <IconButton
        label={t('common.back')}
        icon={<ArrowLeft size={16} />}
        disabled={!canGoBack}
        onClick={onBack}
        className="disabled:hover:bg-transparent"
      />
      {/* Centered on the window, not on the space between the side controls. */}
      <div className="pointer-events-none absolute inset-y-0 left-1/2 flex w-[min(460px,calc(100vw-440px))] -translate-x-1/2 items-center">
        <SearchBox
          ref={searchRef}
          value={query}
          onChange={onQueryChange}
          onSubmit={onSubmit}
          loading={searching}
          className="pointer-events-auto w-full"
        />
      </div>
      <div className="ml-auto flex items-center">
        <Tooltip content={avatarLabel} side="bottom">
          <button
            type="button"
            aria-label={avatarLabel}
            onClick={() => nav.openSettings(null)}
            className="no-drag mr-2 inline-flex h-7 w-7 items-center justify-center rounded-full bg-accent-soft text-[12.5px] font-semibold text-accent-text ring-1 ring-accent/25 transition-[box-shadow,filter] duration-150 ring-inset hover:ring-accent/60"
          >
            {initial ?? <UserRound size={14} />}
          </button>
        </Tooltip>
        <WindowControls />
      </div>
    </header>
  )
})
