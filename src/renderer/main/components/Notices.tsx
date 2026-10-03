import { useRef, useState } from 'react'
import { t } from '@shared/i18n'
import type { Notice, NoticeAction } from '@shared/types'
import { Banner, Button, ConfirmDialog } from '../../components/ui'
import { errorMessage, invoke, on } from '../../lib/ipc'
import { useNotices } from '../hooks/useNotices'
import { installUpdate, updateBlocker, type InstallDeps } from '../lib/installUpdate'
import { useNav, type Nav } from '../router'
import { toast } from '../stores/toast'

const installDeps: InstallDeps = {
  getStatus: () => invoke('session:getState').then((s) => s.status),
  stop: () => invoke('session:stop'),
  onStatus: (listener) => on('session:state', (s) => listener(s.status)),
  install: () => invoke('updater:install'),
}

async function runAction(action: NoticeAction, nav: Nav, signal: AbortSignal): Promise<void> {
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
      await installUpdate(installDeps, signal)
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
  // The action in progress: "Restart & update" can wait for a call's notes, and Cancel ends that.
  const running = useRef<AbortController | null>(null)
  const action = notice.action

  const run = (a: NoticeAction) => {
    const ctrl = new AbortController()
    running.current = ctrl
    setBusy(true)
    runAction(a, nav, ctrl.signal)
      .catch((err: unknown) => {
        if (!ctrl.signal.aborted) {
          toast(`${t('home.notices.actionFailed')} ${errorMessage(err)}`, 'error')
        }
      })
      .finally(() => {
        if (running.current !== ctrl) return
        running.current = null
        setBusy(false)
        setConfirm(null)
      })
  }

  /** Closes the dialog; while waiting for the call to stop or its notes, don't restart after all. */
  const cancel = () => {
    running.current?.abort()
    running.current = null
    setBusy(false)
    setConfirm(null)
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
            if (!open) cancel()
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
          // Stopping the call is the drastic part; waiting for notes loses nothing.
          danger={confirm !== 'notes'}
          busy={busy}
          onConfirm={() => {
            if (!busy) run(action.action)
          }}
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
