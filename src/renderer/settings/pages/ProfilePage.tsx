import { useState } from 'react'
import { t } from '@shared/i18n'
import type { Settings } from '@shared/settings'
import { Input, Textarea } from '../../components/ui'
import { useSettings } from '../../stores/settings'
import { FieldLabel, PageHeader, SaveIndicator, StatusLine } from '../components/bits'
import { useDebouncedSave } from '../hooks'
import { describeError } from '../lib/errors'

type Profile = Settings['profile']

export function ProfilePage() {
  const saved = useSettings((s) => s.settings.profile)
  const update = useSettings((s) => s.update)
  // Local copy: typing never fights with settings:changed echoes.
  const [profile, setProfile] = useState<Profile>(saved)
  const autosave = useDebouncedSave<Partial<Profile>>(async (patch) => {
    try {
      await update({ profile: patch })
    } catch (err) {
      throw new Error(describeError(err))
    }
  })

  const field = (key: keyof Profile) => ({
    id: `profile-${key}`,
    value: profile[key],
    onChange: (e: { target: { value: string } }) => {
      const value = e.target.value
      setProfile((p) => ({ ...p, [key]: value }))
      autosave.schedule({ [key]: value })
    },
  })

  return (
    <div>
      <PageHeader
        title={t('settings.profile.title')}
        subtitle={t('settings.profile.subtitle')}
        actions={<SaveIndicator state={autosave.state} />}
      />
      <div className="grid grid-cols-2 gap-x-4 gap-y-4">
        <div className="col-span-2">
          <FieldLabel htmlFor="profile-name">{t('settings.profile.name')}</FieldLabel>
          <Input
            {...field('name')}
            maxLength={200}
            autoComplete="name"
            placeholder={t('settings.profile.namePlaceholder')}
          />
        </div>
        <div>
          <FieldLabel htmlFor="profile-role">{t('settings.profile.role')}</FieldLabel>
          <Input
            {...field('role')}
            maxLength={200}
            autoComplete="organization-title"
            placeholder={t('settings.profile.rolePlaceholder')}
          />
        </div>
        <div>
          <FieldLabel htmlFor="profile-company">{t('settings.profile.company')}</FieldLabel>
          <Input
            {...field('company')}
            maxLength={200}
            autoComplete="organization"
            placeholder={t('settings.profile.companyPlaceholder')}
          />
        </div>
        <div className="col-span-2">
          <FieldLabel htmlFor="profile-about">{t('settings.profile.about')}</FieldLabel>
          <Textarea
            {...field('about')}
            rows={7}
            maxLength={4000}
            placeholder={t('settings.profile.aboutPlaceholder')}
          />
          <div className="mt-1.5 flex justify-between gap-4 text-[12px] text-subtle">
            <span>{t('settings.profile.aboutHint')}</span>
            <span className="tabular shrink-0">{profile.about.length} / 4000</span>
          </div>
        </div>
      </div>
      {autosave.state === 'error' && autosave.error ? (
        <StatusLine tone="error" className="mt-3">
          {t('settings.saveFailed', { error: autosave.error })}
        </StatusLine>
      ) : null}
    </div>
  )
}
