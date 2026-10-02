/**
 * The Settings modal: a large sheet with a left navigation (like a native preferences window)
 * and a scrolling content area. Rendered by the main window; it owns no routing state itself.
 */
import {
  Bug,
  CircleHelp,
  Keyboard,
  Languages,
  Layers,
  Power,
  ScrollText,
  Settings2,
  ShieldCheck,
  Sparkles,
  UserRound,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ISSUES_URL } from '@shared/constants'
import { t } from '@shared/i18n'
import type { SettingsPage } from '@shared/types'
import { cn, ConfirmDialog, DialogClose, Sheet } from '../components/ui'
import { invoke } from '../lib/ipc'
import { GeneralPage } from './pages/GeneralPage'
import { KeybindsPage } from './pages/KeybindsPage'
import { LanguagePage } from './pages/LanguagePage'
import { ModelsPage } from './pages/ModelsPage'
import { ModesPage } from './pages/ModesPage'
import { PrivacyPage } from './pages/PrivacyPage'
import { ProfilePage } from './pages/ProfilePage'
import { HelpPage, ReleaseNotesPage } from './pages/SupportPages'

export interface SettingsSheetProps {
  open: boolean
  /** Page to show; null shows General. */
  page: SettingsPage | null
  onOpenChange(open: boolean): void
  onNavigate(page: SettingsPage): void
}

interface NavItem {
  page: SettingsPage
  icon: LucideIcon
  label: () => string
}

const MAIN_NAV: NavItem[] = [
  { page: 'general', icon: Settings2, label: () => t('settings.nav.general') },
  { page: 'models', icon: Sparkles, label: () => t('settings.nav.models') },
  { page: 'modes', icon: Layers, label: () => t('settings.nav.modes') },
  { page: 'keybinds', icon: Keyboard, label: () => t('settings.nav.keybinds') },
  { page: 'profile', icon: UserRound, label: () => t('settings.nav.profile') },
  { page: 'language', icon: Languages, label: () => t('settings.nav.language') },
  { page: 'privacy', icon: ShieldCheck, label: () => t('settings.nav.privacy') },
]

const SUPPORT_NAV: NavItem[] = [
  { page: 'releaseNotes', icon: ScrollText, label: () => t('settings.nav.releaseNotes') },
  { page: 'help', icon: CircleHelp, label: () => t('settings.nav.help') },
]

function renderPage(page: SettingsPage): ReactNode {
  switch (page) {
    case 'general':
      return <GeneralPage />
    case 'models':
      return <ModelsPage />
    case 'modes':
      return <ModesPage />
    case 'keybinds':
      return <KeybindsPage />
    case 'profile':
      return <ProfilePage />
    case 'language':
      return <LanguagePage />
    case 'privacy':
      return <PrivacyPage />
    case 'releaseNotes':
      return <ReleaseNotesPage />
    case 'help':
      return <HelpPage />
  }
}

const navItemClass =
  'no-drag flex h-9 w-full items-center gap-3 rounded-[10px] px-3 text-left text-[13.5px] transition-colors duration-150'

function NavButton({
  item,
  active,
  onNavigate,
}: {
  item: NavItem
  active: boolean
  onNavigate: (page: SettingsPage) => void
}) {
  const Icon = item.icon
  return (
    <button
      type="button"
      aria-current={active ? 'page' : undefined}
      onClick={() => onNavigate(item.page)}
      data-testid={`settings-nav-${item.page}`}
      className={cn(
        navItemClass,
        active ? 'bg-panel-4 font-medium text-fg' : 'text-muted hover:bg-panel-3 hover:text-fg',
      )}
    >
      <Icon size={17} aria-hidden="true" className={active ? 'text-fg' : 'text-muted'} />
      {item.label()}
    </button>
  )
}

/**
 * Scrolling content column. It mounts each time the sheet opens and takes focus first, so the
 * dialog does not auto-focus (and ring) the close button, and PageUp/PageDown scroll the page.
 */
function PageArea({ page }: { page: SettingsPage }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.focus({ preventScroll: true })
  }, [])
  return (
    // Keyed by page so each page starts scrolled to the top with fresh local state.
    <div
      key={page}
      ref={ref}
      tabIndex={-1}
      className="min-w-0 flex-1 overflow-y-auto [scrollbar-gutter:stable] focus:outline-none focus-visible:outline-none"
      data-testid={`settings-page-${page}`}
    >
      <div className="px-8 pt-7 pb-10">{renderPage(page)}</div>
    </div>
  )
}

export function SettingsSheet({ open, page, onOpenChange, onNavigate }: SettingsSheetProps) {
  const current: SettingsPage = page ?? 'general'
  const [confirmQuit, setConfirmQuit] = useState(false)
  const [quitting, setQuitting] = useState(false)

  const quit = async () => {
    setQuitting(true)
    try {
      await invoke('app:quit')
    } catch {
      setQuitting(false)
      setConfirmQuit(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t('settings.title')}>
      <nav
        aria-label={t('settings.nav.label')}
        className="flex w-[248px] shrink-0 flex-col border-r border-line bg-panel-2 px-3 pt-3 pb-3"
        data-testid="settings-nav"
      >
        <DialogClose
          aria-label={t('settings.nav.close')}
          className="no-drag ml-1 inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-panel-3 hover:text-fg"
        >
          <X size={17} />
        </DialogClose>
        <div className="mt-3 flex flex-col gap-0.5">
          {MAIN_NAV.map((item) => (
            <NavButton
              key={item.page}
              item={item}
              active={item.page === current}
              onNavigate={onNavigate}
            />
          ))}
        </div>
        <div className="mt-6 mb-1.5 px-3 text-[12px] font-medium text-subtle">
          {t('settings.nav.support')}
        </div>
        <div className="flex flex-col gap-0.5">
          {SUPPORT_NAV.map((item) => (
            <NavButton
              key={item.page}
              item={item}
              active={item.page === current}
              onNavigate={onNavigate}
            />
          ))}
          <button
            type="button"
            onClick={() =>
              void invoke('app:openExternal', { url: ISSUES_URL }).catch(() => undefined)
            }
            className={cn(navItemClass, 'text-muted hover:bg-panel-3 hover:text-fg')}
          >
            <Bug size={17} aria-hidden="true" />
            {t('settings.nav.reportIssue')}
          </button>
        </div>
        <div className="mt-auto pt-3">
          <button
            type="button"
            onClick={() => setConfirmQuit(true)}
            data-testid="settings-quit"
            className={cn(navItemClass, 'text-muted hover:bg-danger-soft hover:text-danger')}
          >
            <Power size={17} aria-hidden="true" />
            {t('settings.nav.quit')}
          </button>
        </div>
      </nav>

      <PageArea page={current} />

      <ConfirmDialog
        open={confirmQuit}
        onOpenChange={setConfirmQuit}
        title={t('settings.quit.title')}
        description={t('settings.quit.description')}
        confirmLabel={t('settings.quit.confirm')}
        danger
        busy={quitting}
        onConfirm={() => void quit()}
      />
    </Sheet>
  )
}
