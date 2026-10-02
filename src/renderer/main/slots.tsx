/**
 * Integration seam for UI built by other slices. These are placeholders: the integrator
 * replaces this file's body with `export { SettingsSheet, Onboarding } from '../settings'`.
 */
import { t } from '@shared/i18n'
import type { SettingsPage } from '@shared/types'
import { Button, DialogClose, LogoMark, Sheet } from '../components/ui'

export function SettingsSheet(props: {
  open: boolean
  page: SettingsPage | null
  onOpenChange(open: boolean): void
  onNavigate(page: SettingsPage): void
}) {
  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange} title={t('common.settings')}>
      <div className="flex flex-1 flex-col items-start p-8" data-testid="settings-placeholder">
        <h2 className="text-[16px] font-semibold text-fg">{t('home.placeholder.settingsTitle')}</h2>
        <p className="mt-1 text-[13px] text-muted">{t('home.placeholder.settingsBody')}</p>
        <code className="mt-3 text-[12px] text-subtle">{props.page ?? 'general'}</code>
        <DialogClose asChild>
          <Button className="mt-6">{t('common.close')}</Button>
        </DialogClose>
      </div>
    </Sheet>
  )
}

export function Onboarding(props: { onDone(): void }) {
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-3 text-center"
      data-testid="onboarding-placeholder"
    >
      <LogoMark size={56} />
      <h1 className="mt-2 text-[22px] font-semibold text-fg">
        {t('home.placeholder.onboardingTitle')}
      </h1>
      <p className="text-[13.5px] text-muted">{t('home.placeholder.onboardingBody')}</p>
      <Button variant="primary" size="lg" className="mt-4" onClick={props.onDone}>
        {t('home.placeholder.onboardingStart')}
      </Button>
    </div>
  )
}
