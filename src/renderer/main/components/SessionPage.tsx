import { useState, type ReactNode } from 'react'
import { AlertCircle, ArrowLeft, SearchX } from 'lucide-react'
import { t } from '@shared/i18n'
import type { SessionDetail, SessionTab } from '@shared/types'
import { Badge, Button, TabList, TabsContent, TabsRoot, type TabItem } from '../../components/ui'
import { formatClock, formatDay, formatDuration } from '../../lib/format'
import { errorMessage, invoke } from '../../lib/ipc'
import { useSessionDetail } from '../hooks/useSessionDetail'
import { useNav } from '../router'
import { toast } from '../stores/toast'
import { ActionItemsTab } from '../tabs/ActionItemsTab'
import { ChatTab } from '../tabs/ChatTab'
import { EmailTab } from '../tabs/EmailTab'
import { NotesTab } from '../tabs/NotesTab'
import { TranscriptTab } from '../tabs/TranscriptTab'
import { EditableTitle } from './EditableTitle'
import { SessionBanners } from './SessionBanners'
import { SessionToolbar } from './SessionToolbar'
import { StatusChip } from './StatusChip'

const TABS: SessionTab[] = ['notes', 'actions', 'transcript', 'email', 'chat']

function isTab(v: string): v is SessionTab {
  return (TABS as string[]).includes(v)
}

function MetaLine({ detail }: { detail: SessionDetail }) {
  const parts: ReactNode[] = [`${formatDay(detail.startedAt)} · ${formatClock(detail.startedAt)}`]
  if (detail.durationMs != null && detail.status !== 'active')
    parts.push(<span className="tabular">{formatDuration(detail.durationMs)}</span>)
  if (detail.modeName) parts.push(detail.modeName)
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted">
      {parts.map((p, i) => (
        <span key={i} className="inline-flex items-center gap-2">
          {i > 0 ? (
            <span aria-hidden="true" className="text-subtle">
              ·
            </span>
          ) : null}
          {p}
        </span>
      ))}
      <StatusChip status={detail.status} />
    </div>
  )
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 pb-16 text-center">
      {children}
    </div>
  )
}

/** Meeting detail: editable title, meta, export actions, status banners and five tabs. */
export function SessionPage({ sessionId, tab }: { sessionId: string; tab: SessionTab }) {
  const nav = useNav()
  const { detail, status, error, patch } = useSessionDetail(sessionId)
  const [regenerating, setRegenerating] = useState(false)

  if (status === 'loading') {
    return (
      <div className="h-full bg-panel" aria-busy="true">
        <div className="mx-auto max-w-[920px] px-10 pt-7">
          <div className="h-7 w-1/2 rounded-md bg-panel-3" />
          <div className="mt-3 h-3.5 w-1/3 rounded bg-panel-2" />
        </div>
      </div>
    )
  }

  if (status === 'missing' || status === 'error' || !detail) {
    const missing = status === 'missing'
    return (
      <Centered>
        {missing ? (
          <SearchX size={26} className="mb-3 text-subtle" />
        ) : (
          <AlertCircle size={26} className="mb-3 text-subtle" />
        )}
        <div className="text-[15px] font-semibold text-fg">
          {missing ? t('session.notFound') : t('session.loadFailed')}
        </div>
        <div className="mt-1 text-[13px] text-muted">
          {missing ? t('session.notFoundBody') : error}
        </div>
        <Button
          className="mt-5"
          size="sm"
          variant="secondary"
          icon={<ArrowLeft size={13} />}
          onClick={nav.goHome}
        >
          {t('session.backHome')}
        </Button>
      </Centered>
    )
  }

  const title = detail.title.trim() || t('home.untitled')
  const openCount = detail.actionItems.filter((a) => !a.done).length

  const rename = (next: string) => {
    const prev = detail.title
    patch((d) => ({ ...d, title: next }))
    invoke('sessions:rename', { id: detail.id, title: next }).catch((err: unknown) => {
      patch((d) => ({ ...d, title: prev }))
      toast(`${t('session.title.renameFailed')}: ${errorMessage(err)}`, 'error')
    })
  }

  const regenerate = () => {
    setRegenerating(true)
    invoke('sessions:regenerate', { id: detail.id })
      .then(() => patch((d) => ({ ...d, status: 'processing', postCallError: null })))
      .catch((err: unknown) =>
        toast(`${t('session.banner.regenerateFailed')}: ${errorMessage(err)}`, 'error'),
      )
      .finally(() => setRegenerating(false))
  }

  const items: TabItem<SessionTab>[] = [
    { value: 'notes', label: t('session.tabs.notes') },
    {
      value: 'actions',
      label: t('session.tabs.actions'),
      badge: openCount > 0 ? <Badge tone="accent">{openCount}</Badge> : undefined,
    },
    { value: 'transcript', label: t('session.tabs.transcript') },
    { value: 'email', label: t('session.tabs.email') },
    { value: 'chat', label: t('session.tabs.chat') },
  ]

  const scrolling = (content: ReactNode) => (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[920px] px-10 pt-7 pb-16">{content}</div>
    </div>
  )

  return (
    <TabsRoot
      value={tab}
      onValueChange={(v) => isTab(v) && nav.setTab(v)}
      className="flex h-full flex-col"
      data-testid="session-page"
    >
      <div className="shrink-0 bg-panel">
        <div className="mx-auto max-w-[920px] px-10 pt-6">
          <div className="flex items-start gap-4">
            <div className="min-w-0 flex-1">
              <EditableTitle key={detail.title} title={title} onRename={rename} />
              <div className="mt-1">
                <MetaLine detail={detail} />
              </div>
            </div>
            <div className="pt-1.5">
              <SessionToolbar id={detail.id} title={title} onDeleted={nav.back} />
            </div>
          </div>
          <div className="mt-4 empty:hidden">
            <SessionBanners detail={detail} onRegenerate={regenerate} regenerating={regenerating} />
          </div>
          <TabList items={items} className="mt-5" />
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <TabsContent value="notes" className="h-full focus-visible:outline-none">
          {scrolling(<NotesTab detail={detail} title={title} onRegenerate={regenerate} />)}
        </TabsContent>
        <TabsContent value="actions" className="h-full focus-visible:outline-none">
          {scrolling(<ActionItemsTab detail={detail} patch={patch} />)}
        </TabsContent>
        <TabsContent value="transcript" className="h-full focus-visible:outline-none">
          {scrolling(<TranscriptTab detail={detail} />)}
        </TabsContent>
        <TabsContent value="email" className="h-full focus-visible:outline-none">
          {scrolling(<EmailTab detail={detail} patch={patch} />)}
        </TabsContent>
        <TabsContent value="chat" className="h-full focus-visible:outline-none">
          <ChatTab sessionId={detail.id} />
        </TabsContent>
      </div>
    </TabsRoot>
  )
}
