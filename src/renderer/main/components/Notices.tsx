import { useState } from 'react'
import { t } from '@shared/i18n'
import type { LiveSessionState, Notice, NoticeAction } from '@shared/types'
import { Banner, Button, ConfirmDialog } from '../../components/ui'
import { errorMessage, invoke } from '../../lib/ipc'
import { useNotices } from '../hooks/useNotices'
import { useNav, type Nav } from '../router'
import { toast } from '../stores/toast'

type CallStatus = LiveSessionState['status']

/** Session states in which "Restart to update" would end something the user cares about. */
function updateBlocker(status: CallStatus): 'call' | 'notes' | null {
  if (status === 'starting' || status === 'live' || status === 'stopping') return 'call'
  if (status === 'processing') return 'notes'
  return null
}

/** Installing quits Bluely: stop a running call first (main refuses to install during one). */
async function installUpdate(): Promise<void> {
  const { status } = await invoke('session:getState')
  if (status === 'starting' || status === 'live') await invoke('session:stop')
  await invoke('updater:install')
}

async function runAction(action: NoticeAction, nav: Nav): Promise<void> {
  switch (action.type) {
    case 'openSettings':
      nav.openSettings(action.page)
      return
    case 'openSession':
      nav.openSession(action.sessionId)
      return
    case 'regenerateSession':
      await invoke('sessions:regenerate', { id: action.sessionId })
      toast(t('home.notices.regenerating'))
      return
    case 'installUpdate':
      await installUpdate()
      return
    case 'openExternal':
      await invoke('app:openExternal', { url: action.url })
      return
  }
}

function NoticeBanner({ notice, onDismiss }: { notice: Notice; onDismiss(): void }) {
  const nav = useNav()
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<'call' | 'notes' | null>(null)
  const action = notice.action

  const run = (a: NoticeAction) => {
    setBusy(true)
    runAction(a, nav)
      .catch((err: unknown) =>
        toast(`${t('home.notices.actionFailed')} ${errorMessage(err)}`, 'error'),
      )
      .finally(() => {
        setBusy(false)
        setConfirm(null)
      })
  }

  const onAction = (a: NoticeAction) => {
    if (a.type !== 'installUpdate') return run(a)
    // Ask before quitting in the middle of a call (or while its notes are being written).
    setBusy(true)
    invoke('session:getState')
      .then((s) => {
        const blocker = updateBlocker(s.status)
        if (blocker) {
          setBusy(false)
          setConfirm(blocker)
        } else run(a)
      })
      .catch(() => run(a))
  }

  return (
    <>
      <Banner
        tone={notice.kind}
        title={notice.title}
        onDismiss={notice.dismissible ? onDismiss : undefined}
        action={
          action ? (
            <Button
              size="sm"
              variant="secondary"
              loading={busy && !confirm}
              onClick={() => onAction(action.action)}
            >
              {action.label}
            </Button>
          ) : undefined
        }
      >
        {notice.body}
      </Banner>
      {action ? (
        <ConfirmDialog
          open={confirm !== null}
          onOpenChange={(open) => {
            if (!open && !busy) setConfirm(null)
          }}
          title={
            confirm === 'notes'
              ? t('home.notices.installProcessingTitle')
              : t('home.notices.installLiveTitle')
          }
          description={
            confirm === 'notes'
              ? t('home.notices.installProcessingBody')
              : t('home.notices.installLiveBody')
          }
          confirmLabel={
            confirm === 'notes'
              ? t('home.notices.installProcessingConfirm')
              : t('home.notices.installLiveConfirm')
          }
          danger
          busy={busy}
          onConfirm={() => run(action.action)}
        />
      ) : null}
    </>
  )
}

/** Banner area under the header (missing key, update available, recovered session, …). */
export function Notices() {
  const { notices, dismiss } = useNotices()
  if (notices.length === 0) return null
  return (
    <div className="mt-6 flex flex-col gap-2" data-testid="notices">
      {notices.map((n) => (
        <NoticeBanner key={n.id} notice={n} onDismiss={() => dismiss(n.id)} />
      ))}
    </div>
  )
}
