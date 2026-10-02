import { t } from '@shared/i18n'
import type { SessionStatus } from '@shared/types'
import { Badge, Spinner } from '../../components/ui'

/** Small chip for sessions that are not simply "done". Renders nothing for 'done'. */
export function StatusChip({ status }: { status: SessionStatus }) {
  switch (status) {
    case 'active':
      return (
        <Badge tone="danger">
          <span className="animate-pulse-dot h-1.5 w-1.5 rounded-full bg-danger" />
          {t('home.list.status.active')}
        </Badge>
      )
    case 'processing':
      return (
        <Badge tone="accent">
          <Spinner size={10} />
          {t('home.list.status.processing')}
        </Badge>
      )
    case 'recovered':
      return <Badge tone="warning">{t('home.list.status.recovered')}</Badge>
    case 'failed':
      return <Badge tone="danger">{t('home.list.status.failed')}</Badge>
    default:
      return null
  }
}
