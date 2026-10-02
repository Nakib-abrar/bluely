import { Camera, Clock, FileDown, FolderOpen, HardDrive, ShieldCheck, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { REPO_URL } from '@shared/constants'
import { t } from '@shared/i18n'
import type { Settings } from '@shared/settings'
import {
  Button,
  Card,
  Dialog,
  Input,
  Select,
  SettingsRow,
  SettingsSection,
  Switch,
  type SelectOption,
} from '../../components/ui'
import { invoke } from '../../lib/ipc'
import { useSettings } from '../../stores/settings'
import { ExternalLinkButton, PageHeader, StatusLine } from '../components/bits'
import { useAppInfo } from '../hooks'
import { describeError } from '../lib/errors'

type Retention = Settings['privacy']['retentionDays']
const RETENTION_VALUES: Retention[] = [0, 30, 90, 365]
const CONFIRM_WORD = 'DELETE'

type Result = { tone: 'success' | 'error'; text: string } | null

function DeleteAllDialog({
  open,
  onOpenChange,
  onDeleted,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onDeleted: () => void
}) {
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const confirmed = typed.trim() === CONFIRM_WORD

  const close = (next: boolean) => {
    if (!next) {
      setTyped('')
      setError(null)
    }
    onOpenChange(next)
  }

  const run = async () => {
    if (!confirmed) return
    setBusy(true)
    setError(null)
    try {
      await invoke('data:deleteAll', { confirm: CONFIRM_WORD })
      close(false)
      onDeleted()
    } catch (err) {
      setError(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title={t('settings.privacy.deleteConfirmTitle')}
      description={t('settings.privacy.deleteConfirmDescription')}
      footer={
        <>
          <Button variant="ghost" onClick={() => close(false)}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" disabled={!confirmed} loading={busy} onClick={() => void run()}>
            {t('settings.privacy.deleteConfirm')}
          </Button>
        </>
      }
    >
      <label htmlFor="delete-confirm" className="mb-1.5 block text-[12.5px] text-muted">
        {t('settings.privacy.deleteConfirmPrompt')}
      </label>
      <Input
        id="delete-confirm"
        value={typed}
        autoFocus
        autoComplete="off"
        spellCheck={false}
        placeholder={CONFIRM_WORD}
        onChange={(e) => setTyped(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void run()
        }}
        className="font-mono"
      />
      {error ? (
        <StatusLine tone="error" className="mt-2">
          {error}
        </StatusLine>
      ) : null}
    </Dialog>
  )
}

export function PrivacyPage() {
  const privacy = useSettings((s) => s.settings.privacy)
  const update = useSettings((s) => s.update)
  const info = useAppInfo()
  const [saveError, setSaveError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [exportResult, setExportResult] = useState<Result>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteResult, setDeleteResult] = useState<Result>(null)
  const [folderError, setFolderError] = useState<string | null>(null)

  const save = (patch: Partial<Settings['privacy']>) =>
    void update({ privacy: patch })
      .then(() => setSaveError(null))
      .catch((err: unknown) =>
        setSaveError(t('settings.saveFailed', { error: describeError(err) })),
      )

  const retentionOptions: SelectOption<string>[] = RETENTION_VALUES.map((d) => ({
    value: String(d),
    label:
      d === 0
        ? t('settings.privacy.retentionForever')
        : t('settings.privacy.retentionDays', { n: d }),
  }))

  const exportAll = async () => {
    setExporting(true)
    setExportResult(null)
    try {
      const { path } = await invoke('data:exportAll')
      // null = the user cancelled the save dialog.
      if (path) setExportResult({ tone: 'success', text: t('settings.privacy.exported', { path }) })
    } catch (err) {
      setExportResult({ tone: 'error', text: describeError(err) })
    } finally {
      setExporting(false)
    }
  }

  return (
    <div>
      <PageHeader title={t('settings.privacy.title')} subtitle={t('settings.privacy.subtitle')} />
      <div className="-mt-3">
        <SettingsRow
          icon={<HardDrive size={18} />}
          title={t('settings.privacy.folderTitle')}
          description={
            <span
              className="selectable block truncate font-mono text-[12px]"
              title={info?.dataDir}
              data-testid="data-dir"
            >
              {info?.dataDir ?? '…'}
            </span>
          }
          control={
            <Button
              icon={<FolderOpen size={14} />}
              onClick={() =>
                void invoke('app:openDataFolder').catch((err: unknown) =>
                  setFolderError(describeError(err)),
                )
              }
            >
              {t('settings.privacy.openFolder')}
            </Button>
          }
        >
          {folderError ? (
            <StatusLine tone="error" className="pl-[54px]">
              {folderError}
            </StatusLine>
          ) : null}
        </SettingsRow>
        <SettingsRow
          icon={<Clock size={18} />}
          title={t('settings.privacy.retentionTitle')}
          description={t('settings.privacy.retentionDescription')}
          control={
            <Select
              value={String(privacy.retentionDays)}
              onValueChange={(v) => {
                const days = Number(v) as Retention
                if (RETENTION_VALUES.includes(days)) save({ retentionDays: days })
              }}
              options={retentionOptions}
              label={t('settings.privacy.retentionTitle')}
              className="w-[150px]"
            />
          }
        />
        <SettingsRow
          icon={<Camera size={18} />}
          title={t('settings.privacy.screenshotsTitle')}
          description={t('settings.privacy.screenshotsDescription')}
          control={
            <Switch
              checked={privacy.saveScreenshots}
              onCheckedChange={(v) => save({ saveScreenshots: v })}
              label={t('settings.privacy.screenshotsTitle')}
            />
          }
        />
        <SettingsRow
          icon={<FileDown size={18} />}
          title={t('settings.privacy.exportTitle')}
          description={t('settings.privacy.exportDescription')}
          control={
            <Button loading={exporting} onClick={() => void exportAll()}>
              {t('settings.privacy.export')}
            </Button>
          }
        >
          {exportResult ? (
            <StatusLine tone={exportResult.tone} className="pl-[54px]">
              {exportResult.text}
            </StatusLine>
          ) : null}
        </SettingsRow>
        <SettingsRow
          icon={<Trash2 size={18} className="text-danger" />}
          title={t('settings.privacy.deleteTitle')}
          description={t('settings.privacy.deleteDescription')}
          control={
            <Button
              variant="outline"
              className="border-danger/40! text-danger! hover:bg-danger-soft!"
              onClick={() => {
                setDeleteResult(null)
                setDeleteOpen(true)
              }}
            >
              {t('settings.privacy.delete')}
            </Button>
          }
        >
          {deleteResult ? (
            <StatusLine tone={deleteResult.tone} className="pl-[54px]">
              {deleteResult.text}
            </StatusLine>
          ) : null}
        </SettingsRow>
        {saveError ? <StatusLine tone="error">{saveError}</StatusLine> : null}
      </div>

      <SettingsSection title={t('settings.privacy.sentTitle')} className="mt-6">
        <Card className="mt-3">
          <div className="flex gap-3.5">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-accent-soft text-accent-text">
              <ShieldCheck size={18} />
            </div>
            <ul
              className="flex-1 space-y-2 text-[13px] leading-relaxed text-fg"
              data-testid="sent-list"
            >
              {(
                [
                  'settings.privacy.sentAudio',
                  'settings.privacy.sentPrompts',
                  'settings.privacy.sentScreen',
                  'settings.privacy.sentNothingElse',
                ] as const
              ).map((key) => (
                <li key={key} className="flex gap-2">
                  <span
                    aria-hidden="true"
                    className="mt-[8px] h-1.5 w-1.5 shrink-0 rounded-full bg-accent-2"
                  />
                  <span>{t(key)}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="mt-3 border-t border-line pt-3 pl-[54px]">
            <ExternalLinkButton href={`${REPO_URL}/blob/main/PRIVACY.md`} className="text-[12.5px]">
              {t('settings.privacy.readPolicy')}
            </ExternalLinkButton>
          </div>
        </Card>
      </SettingsSection>

      <DeleteAllDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onDeleted={() => setDeleteResult({ tone: 'success', text: t('settings.privacy.deleted') })}
      />
    </div>
  )
}
