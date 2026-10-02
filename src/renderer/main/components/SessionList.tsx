import { useMemo, useState, type ReactNode } from 'react'
import { AlertCircle } from 'lucide-react'
import { t } from '@shared/i18n'
import type { SessionSummary } from '@shared/types'
import { Button, ConfirmDialog } from '../../components/ui'
import { errorMessage, invoke } from '../../lib/ipc'
import { useSessions } from '../hooks/useSessions'
import { groupByDay } from '../lib/group'
import { useNav } from '../router'
import { toast } from '../stores/toast'
import { HomeEmptyState } from './HomeEmptyState'
import { SessionRow } from './SessionRow'

function ListSkeleton() {
  return (
    <div aria-hidden="true" className="animate-fade-in">
      {[0, 1].map((g) => (
        <div key={g} className="mb-7">
          <div className="mb-2 h-3 w-24 rounded bg-panel-2" />
          {[0, 1, 2].slice(0, 3 - g).map((r) => (
            <div key={r} className="flex h-11 items-center gap-3 px-3.5">
              <div className="h-3.5 rounded bg-panel-2" style={{ width: `${46 - r * 9}%` }} />
              <div className="ml-auto h-4 w-12 rounded-md bg-panel-2" />
              <div className="h-3 w-12 rounded bg-panel-2" />
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

/** Meeting history grouped by day, with paging, row menu and delete confirmation. */
export function SessionList() {
  const nav = useNav()
  const view = useSessions()
  const groups = useMemo(() => groupByDay(view.sessions), [view.sessions])
  const [toDelete, setToDelete] = useState<SessionSummary | null>(null)
  const [deleting, setDeleting] = useState(false)

  const confirmDelete = () => {
    if (!toDelete) return
    const id = toDelete.id
    setDeleting(true)
    invoke('sessions:delete', { id })
      .then(() => {
        view.remove(id)
        toast(t('home.list.deleted'), 'success')
        setToDelete(null)
      })
      .catch((err: unknown) =>
        toast(`${t('home.list.deleteFailed')}: ${errorMessage(err)}`, 'error'),
      )
      .finally(() => setDeleting(false))
  }

  let body: ReactNode
  if (view.status === 'loading') body = <ListSkeleton />
  else if (view.status === 'error')
    body = (
      <div className="flex flex-col items-center gap-3 py-16 text-center" role="alert">
        <AlertCircle size={22} className="text-subtle" />
        <div>
          <div className="text-[14px] font-medium text-fg">{t('home.list.loadFailed')}</div>
          {view.error ? <div className="mt-1 text-[12.5px] text-subtle">{view.error}</div> : null}
        </div>
        <Button size="sm" variant="secondary" onClick={view.reload}>
          {t('common.retry')}
        </Button>
      </div>
    )
  else if (view.sessions.length === 0) body = <HomeEmptyState />
  else
    body = (
      <>
        {groups.map((g) => (
          <section key={g.key} className="mb-6 last:mb-0" aria-label={g.label}>
            <h3 className="mb-1 text-[12.5px] font-medium text-subtle">{g.label}</h3>
            <ul>
              {g.items.map((s) => (
                <SessionRow
                  key={s.id}
                  session={s}
                  onOpen={() => nav.openSession(s.id)}
                  onDelete={() => setToDelete(s)}
                />
              ))}
            </ul>
          </section>
        ))}
        {view.hasMore ? (
          <div className="mt-6 flex justify-center">
            <Button variant="ghost" size="sm" loading={view.loadingMore} onClick={view.loadMore}>
              {t('home.list.loadMore')}
            </Button>
          </div>
        ) : null}
      </>
    )

  return (
    <>
      {body}
      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) setToDelete(null)
        }}
        title={t('home.list.deleteTitle')}
        description={t('home.list.deleteBody', {
          title: toDelete?.title.trim() || t('home.untitled'),
        })}
        confirmLabel={t('home.list.deleteConfirm')}
        danger
        busy={deleting}
        onConfirm={confirmDelete}
      />
    </>
  )
}
