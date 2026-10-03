import { RotateCcw, Sparkles } from 'lucide-react'
import { t } from '@shared/i18n'
import type { SessionDetail } from '@shared/types'
import { Banner, Button } from '../../components/ui'
import { parsePostCallError, type PostCallPart } from '../lib/postCallError'

/** Status banners on the meeting page: processing, recovered, post-call failure. */
export function SessionBanners({
  detail,
  onRegenerate,
  regenerating,
}: {
  detail: SessionDetail
  /** `parts`: only these failed (a partial post-call failure); omitted = whatever is missing. */
  onRegenerate(parts?: PostCallPart[]): void
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
            onClick={() => onRegenerate()}
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
    const failed = parsePostCallError(detail.postCallError)
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
            onClick={() => onRegenerate(failed?.map((f) => f.part))}
          >
            {t('session.banner.retry')}
          </Button>
        }
      >
        {failed ? (
          <ul data-testid="post-call-errors">
            {failed.map((f) => (
              <li key={f.part}>
                {t('session.banner.partError', {
                  part: t(`session.banner.part.${f.part}`),
                  message: f.message,
                })}
              </li>
            ))}
          </ul>
        ) : (
          detail.postCallError
        )}
      </Banner>
    )
  }
  return null
}
