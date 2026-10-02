import { RotateCcw, Sparkles } from 'lucide-react'
import { t } from '@shared/i18n'
import type { SessionDetail } from '@shared/types'
import { Banner, Button } from '../../components/ui'

/** Status banners on the meeting page: processing, recovered, post-call failure. */
export function SessionBanners({
  detail,
  onRegenerate,
  regenerating,
}: {
  detail: SessionDetail
  onRegenerate(): void
  regenerating: boolean
}) {
  if (detail.status === 'processing') {
    return (
      <Banner tone="info" title={t('session.banner.processing')}>
        {t('session.banner.processingBody')}
      </Banner>
    )
  }
  if (detail.status === 'recovered') {
    return (
      <Banner
        tone="warning"
        title={t('session.banner.recovered')}
        action={
          <Button
            size="sm"
            variant="secondary"
            icon={<Sparkles size={13} />}
            loading={regenerating}
            onClick={onRegenerate}
          >
            {t('session.banner.generate')}
          </Button>
        }
      >
        {t('session.banner.recoveredBody')}
      </Banner>
    )
  }
  if (detail.postCallError || detail.status === 'failed') {
    return (
      <Banner
        tone="error"
        title={t('session.banner.failed')}
        action={
          <Button
            size="sm"
            variant="secondary"
            icon={<RotateCcw size={13} />}
            loading={regenerating}
            onClick={onRegenerate}
          >
            {t('session.banner.retry')}
          </Button>
        }
      >
        {detail.postCallError}
      </Banner>
    )
  }
  return null
}
