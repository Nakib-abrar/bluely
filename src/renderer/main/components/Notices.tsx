import { useState } from 'react'
import { t } from '@shared/i18n'
import type { Notice, NoticeAction } from '@shared/types'
import { Banner, Button } from '../../components/ui'
import { errorMessage, invoke } from '../../lib/ipc'
import { useNotices } from '../hooks/useNotices'
import { useNav, type Nav } from '../router'
import { toast } from '../stores/toast'

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
      await invoke('updater:install')
      return
    case 'openExternal':
      await invoke('app:openExternal', { url: action.url })
      return
  }
}

function NoticeBanner({ notice, onDismiss }: { notice: Notice; onDismiss(): void }) {
  const nav = useNav()
  const [busy, setBusy] = useState(false)
  const action = notice.action
  return (
    <Banner
      tone={notice.kind}
      title={notice.title}
      onDismiss={notice.dismissible ? onDismiss : undefined}
      action={
        action ? (
          <Button
            size="sm"
            variant="secondary"
            loading={busy}
            onClick={() => {
              setBusy(true)
              runAction(action.action, nav)
                .catch((err: unknown) =>
                  toast(`${t('home.notices.actionFailed')} ${errorMessage(err)}`, 'error'),
                )
                .finally(() => setBusy(false))
            }}
          >
            {action.label}
          </Button>
        ) : undefined
      }
    >
      {notice.body}
    </Banner>
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
