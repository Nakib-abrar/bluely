import { useState } from 'react'
import { ClipboardCopy, Download, Trash2 } from 'lucide-react'
import { t } from '@shared/i18n'
import { Button, ConfirmDialog, IconButton } from '../../components/ui'
import { errorMessage, invoke } from '../../lib/ipc'
import { useRefresh } from '../stores/refresh'
import { toast } from '../stores/toast'

/** Export / copy as Markdown / delete for one meeting. */
export function SessionToolbar({
  id,
  title,
  onDeleted,
}: {
  id: string
  title: string
  onDeleted(): void
}) {
  const [exporting, setExporting] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const exportFile = () => {
    setExporting(true)
    invoke('sessions:exportMarkdown', { id, target: 'file' })
      .then(({ path }) => {
        // null = the user cancelled the save dialog.
        if (path) toast(t('session.toolbar.savedTo', { path }), 'success')
      })
      .catch((err: unknown) =>
        toast(`${t('session.toolbar.exportFailed')}: ${errorMessage(err)}`, 'error'),
      )
      .finally(() => setExporting(false))
  }

  const copy = () => {
    invoke('sessions:exportMarkdown', { id, target: 'clipboard' })
      .then(() => toast(t('session.toolbar.copiedMarkdown'), 'success'))
      .catch((err: unknown) =>
        toast(`${t('session.toolbar.exportFailed')}: ${errorMessage(err)}`, 'error'),
      )
  }

  const remove = () => {
    setDeleting(true)
    invoke('sessions:delete', { id })
      .then(() => {
        toast(t('home.list.deleted'), 'success')
        setConfirm(false)
        // The history list stays mounted behind this page; make sure the row disappears.
        useRefresh.getState().bump()
        onDeleted()
      })
      .catch((err: unknown) =>
        toast(`${t('home.list.deleteFailed')}: ${errorMessage(err)}`, 'error'),
      )
      .finally(() => setDeleting(false))
  }

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <Button
        size="sm"
        variant="secondary"
        icon={<Download size={13} />}
        loading={exporting}
        onClick={exportFile}
        title={t('session.toolbar.exportHint')}
      >
        {t('session.toolbar.export')}
      </Button>
      <Button size="sm" variant="secondary" icon={<ClipboardCopy size={13} />} onClick={copy}>
        {t('session.toolbar.copyMarkdown')}
      </Button>
      <IconButton
        label={t('session.toolbar.delete')}
        icon={<Trash2 size={15} className="transition-colors group-hover:text-danger" />}
        onClick={() => setConfirm(true)}
        className="group"
      />
      <ConfirmDialog
        open={confirm}
        onOpenChange={(open) => {
          if (!deleting) setConfirm(open)
        }}
        title={t('home.list.deleteTitle')}
        description={t('home.list.deleteBody', { title })}
        confirmLabel={t('home.list.deleteConfirm')}
        danger
        busy={deleting}
        onConfirm={remove}
      />
    </div>
  )
}
