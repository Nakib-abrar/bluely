import { AudioLines, Globe, MessageSquareText } from 'lucide-react'
import { useState } from 'react'
import { t } from '@shared/i18n'
import type { DeepPartial, Settings } from '@shared/settings'
import { Select, SettingsRow, type SelectOption } from '../../components/ui'
import { useSettings } from '../../stores/settings'
import { PageHeader, StatusLine } from '../components/bits'
import { describeError } from '../lib/errors'
import { TRANSCRIPTION_LANGUAGES } from '../lib/languages'

type AnswerLanguage = Settings['language']['answer']

export function LanguagePage() {
  const language = useSettings((s) => s.settings.language)
  const update = useSettings((s) => s.update)
  const [error, setError] = useState<string | null>(null)

  const save = (patch: DeepPartial<Settings>) =>
    void update(patch)
      .then(() => setError(null))
      .catch((err: unknown) => setError(t('settings.saveFailed', { error: describeError(err) })))

  const transcriptionOptions: SelectOption<string>[] = [
    { value: 'auto', label: t('settings.language.auto') },
    ...TRANSCRIPTION_LANGUAGES.map((l) => ({ value: l.code, label: l.name })),
  ]
  // A code set elsewhere (e.g. imported settings) that is not in the list still shows up.
  if (!transcriptionOptions.some((o) => o.value === language.transcription)) {
    transcriptionOptions.push({ value: language.transcription, label: language.transcription })
  }
  const answerOptions: SelectOption<AnswerLanguage>[] = [
    { value: 'conversation', label: t('settings.language.answerConversation') },
    { value: 'en', label: t('settings.language.answerEnglish') },
    { value: 'bn', label: t('settings.language.answerBangla') },
  ]

  return (
    <div>
      <PageHeader title={t('settings.language.title')} subtitle={t('settings.language.subtitle')} />
      <div className="-mt-3">
        <SettingsRow
          icon={<Globe size={18} />}
          title={t('settings.language.uiTitle')}
          description={t('settings.language.uiDescription')}
          control={
            <Select
              value={language.ui}
              onValueChange={(ui) => save({ language: { ui } })}
              options={[{ value: 'en', label: t('settings.language.english') }]}
              label={t('settings.language.uiTitle')}
              className="w-[200px]"
            />
          }
        />
        <SettingsRow
          icon={<AudioLines size={18} />}
          title={t('settings.language.transcriptionTitle')}
          description={t('settings.language.transcriptionDescription')}
          control={
            <Select
              value={language.transcription}
              onValueChange={(transcription) => save({ language: { transcription } })}
              options={transcriptionOptions}
              label={t('settings.language.transcriptionTitle')}
              className="w-[200px]"
            />
          }
        />
        <SettingsRow
          icon={<MessageSquareText size={18} />}
          title={t('settings.language.answerTitle')}
          description={t('settings.language.answerDescription')}
          control={
            <Select
              value={language.answer}
              onValueChange={(answer) => save({ language: { answer } })}
              options={answerOptions}
              label={t('settings.language.answerTitle')}
              className="w-[200px]"
            />
          }
        />
      </div>
      {error ? (
        <StatusLine tone="error" className="mt-2">
          {error}
        </StatusLine>
      ) : null}
    </div>
  )
}
