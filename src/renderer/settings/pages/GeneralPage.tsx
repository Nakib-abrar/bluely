import { Collapsible } from 'radix-ui'
import {
  ChevronDown,
  Download,
  Layers,
  MessageSquareText,
  Palette,
  Power,
  RotateCcw,
  Sparkles,
} from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { BUILTIN_MODES } from '@shared/builtinModes'
import type { DeepPartial, Settings } from '@shared/settings'
import { t } from '@shared/i18n'
import type { ThemePreference, UpdateStatus } from '@shared/types'
import {
  Button,
  Select,
  SettingsRow,
  SettingsSection,
  Switch,
  type SelectOption,
} from '../../components/ui'
import { useIpcEvent } from '../../hooks/useIpcEvent'
import { invoke } from '../../lib/ipc'
import { useSettings } from '../../stores/settings'
import { AudioSetupCard } from '../components/AudioSetup'
import { Divider, PageHeader, Slider, StatusLine } from '../components/bits'
import { describeError } from '../lib/errors'
import { useAppInfo } from '../hooks'
import { useActiveModeId, useModes } from '../stores'

const BLANK_STATUS: UpdateStatus = {
  state: 'idle',
  version: null,
  progress: null,
  error: null,
  releaseUrl: null,
}

/** Saves a settings patch and reports failures inline instead of throwing. */
function useSave() {
  const update = useSettings((s) => s.update)
  const [error, setError] = useState<string | null>(null)
  const save = (patch: DeepPartial<Settings>) =>
    update(patch)
      .then(() => setError(null))
      .catch((err: unknown) => setError(t('settings.saveFailed', { error: describeError(err) })))
  return { save, error }
}

function UpdateRow() {
  const info = useAppInfo()
  const [status, setStatus] = useState<UpdateStatus>(BLANK_STATUS)

  useEffect(() => {
    let alive = true
    invoke('updater:getStatus')
      .then((s) => alive && setStatus(s))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])
  useIpcEvent('updater:status', setStatus)

  const run = async (action: () => Promise<unknown>) => {
    try {
      await action()
    } catch (err) {
      setStatus((s) => ({ ...s, state: 'error', error: describeError(err) }))
    }
  }

  const check = () =>
    run(async () => {
      setStatus((s) => ({ ...s, state: 'checking', error: null }))
      setStatus(await invoke('updater:check'))
    })

  // electron-updater reports percent (0–100); accept a 0–1 fraction too.
  const rawProgress = status.progress ?? 0
  const pct = Math.round(rawProgress <= 1 ? rawProgress * 100 : rawProgress)
  const version = status.version ?? ''

  let line: ReactNode = null
  let control: ReactNode = (
    <Button onClick={() => void check()} loading={status.state === 'checking'}>
      {t('settings.update.check')}
    </Button>
  )
  switch (status.state) {
    case 'checking':
      line = <StatusLine tone="pending">{t('settings.update.checking')}</StatusLine>
      break
    case 'not-available':
      line = <StatusLine tone="success">{t('settings.update.upToDate')}</StatusLine>
      break
    case 'available':
      line = <StatusLine tone="info">{t('settings.update.available', { version })}</StatusLine>
      control = (
        <Button
          variant="primary"
          icon={<Download size={14} />}
          onClick={() => void run(() => invoke('updater:download'))}
        >
          {t('settings.update.download')}
        </Button>
      )
      break
    case 'downloading':
      line = (
        <div className="flex items-center gap-2.5">
          <div className="h-1.5 w-40 overflow-hidden rounded-full bg-panel-4">
            <div
              className="bluely-gradient h-full rounded-full transition-[width] duration-200"
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="tabular text-[12.5px] text-muted">
            {t('settings.update.downloading', { percent: pct })}
          </span>
        </div>
      )
      control = <Button loading>{t('settings.update.download')}</Button>
      break
    case 'downloaded':
      line = <StatusLine tone="success">{t('settings.update.downloaded', { version })}</StatusLine>
      control = (
        <Button variant="primary" onClick={() => void run(() => invoke('updater:install'))}>
          {t('settings.update.install')}
        </Button>
      )
      break
    case 'unsupported':
      line = <StatusLine tone="info">{status.error ?? t('settings.update.unsupported')}</StatusLine>
      if (status.releaseUrl) {
        const url = status.releaseUrl
        control = (
          <Button onClick={() => void invoke('app:openExternal', { url }).catch(() => undefined)}>
            {t('settings.update.openReleases')}
          </Button>
        )
      }
      break
    case 'error':
      line = (
        <StatusLine tone="error">
          {t('settings.update.error', { error: status.error ?? t('errors.unknown') })}
        </StatusLine>
      )
      control = <Button onClick={() => void check()}>{t('settings.update.tryAgain')}</Button>
      break
    default:
      break
  }

  return (
    <SettingsRow
      icon={<Download size={18} />}
      title={t('settings.general.versionTitle')}
      description={
        <span data-testid="app-version">
          {t('settings.general.versionCurrent', { version: info?.version ?? '…' })}
        </span>
      }
      control={control}
    >
      {line ? (
        <div className="pl-[54px]" data-testid="update-status">
          {line}
        </div>
      ) : null}
    </SettingsRow>
  )
}

function ActiveModeRow() {
  const { modes, status, load, setActive } = useModes()
  const value = useActiveModeId()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (status === 'idle') void load()
  }, [status, load])

  // Until Modes load (or if the feature is unavailable) show the built-in names.
  const list = modes.length ? modes : BUILTIN_MODES
  const options: SelectOption<string>[] = list.map((m) => ({
    value: m.id,
    label: `${m.icon}  ${m.name}`,
  }))
  if (!list.some((m) => m.id === value)) options.unshift({ value, label: value })

  const choose = (id: string) => {
    setError(null)
    setActive(id).catch((err: unknown) => setError(describeError(err)))
  }

  return (
    <SettingsRow
      icon={<Layers size={18} />}
      title={t('settings.general.modeTitle')}
      description={t('settings.general.modeDescription')}
      control={
        <Select
          value={value}
          onValueChange={choose}
          options={options}
          label={t('settings.general.modeTitle')}
          className="w-[210px]"
        />
      }
    >
      {error ? (
        <StatusLine tone="error" className="pl-[54px]">
          {error}
        </StatusLine>
      ) : null}
    </SettingsRow>
  )
}

function SliderSetting({
  title,
  description,
  value,
  min,
  max,
  step,
  format,
  onCommit,
  scale,
}: {
  title: string
  description: string
  value: number
  min: number
  max: number
  step: number
  format: (v: number) => string
  onCommit: (v: number) => Promise<unknown>
  scale?: [string, string]
}) {
  // While dragging show the local value; keep it until the saved value comes back to avoid a flicker.
  const [drag, setDrag] = useState<number | null>(null)
  const shown = drag ?? value
  return (
    <div className="flex items-center gap-6 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] font-medium text-fg">{title}</div>
        <div className="mt-0.5 text-[12.5px] text-muted">{description}</div>
      </div>
      <div className="w-[230px] shrink-0">
        <div className="mb-1.5 flex justify-end">
          <span className="tabular rounded-md bg-panel-3 px-1.5 py-0.5 text-[12px] font-medium text-fg">
            {format(shown)}
          </span>
        </div>
        <Slider
          value={shown}
          min={min}
          max={max}
          step={step}
          label={title}
          onValueChange={setDrag}
          onValueCommit={(v) => {
            setDrag(v)
            void onCommit(v).finally(() => setDrag(null))
          }}
        />
        {scale ? (
          <div className="mt-1 flex justify-between text-[11px] text-subtle">
            <span>{scale[0]}</span>
            <span>{scale[1]}</span>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function AdvancedSection() {
  const advanced = useSettings((s) => s.settings.advanced)
  const { save, error } = useSave()
  const [open, setOpen] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [resetError, setResetError] = useState<string | null>(null)

  const reset = async () => {
    setResetting(true)
    setResetError(null)
    try {
      const next = await invoke('settings:reset', { section: 'advanced' })
      useSettings.setState({ settings: next })
    } catch (err) {
      setResetError(describeError(err))
    } finally {
      setResetting(false)
    }
  }

  const seconds = (v: number) => t('settings.advanced.seconds', { n: Math.round(v) })

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className="mt-6">
      <Collapsible.Trigger asChild>
        <button
          type="button"
          className="no-drag group flex w-full items-center justify-between gap-4 rounded-xl py-2 text-left"
        >
          <span>
            <span className="block text-[15px] font-semibold text-fg">
              {t('settings.general.advancedTitle')}
            </span>
            <span className="mt-0.5 block text-[12.5px] text-muted">
              {t('settings.general.advancedSubtitle')}
            </span>
          </span>
          <ChevronDown
            size={18}
            aria-hidden="true"
            className="shrink-0 text-muted transition-transform duration-200 group-data-[state=open]:rotate-180"
          />
        </button>
      </Collapsible.Trigger>
      <Collapsible.Content className="animate-fade-in">
        <div className="mt-2 rounded-xl border border-line bg-panel-2 px-4 py-1">
          <SliderSetting
            title={t('settings.advanced.vadTitle')}
            description={t('settings.advanced.vadDescription')}
            value={advanced.vadSensitivity}
            min={0}
            max={1}
            step={0.05}
            format={(v) => `${Math.round(v * 100)}%`}
            scale={[t('settings.advanced.low'), t('settings.advanced.high')]}
            onCommit={(v) => save({ advanced: { vadSensitivity: Math.round(v * 100) / 100 } })}
          />
          <Divider />
          <SliderSetting
            title={t('settings.advanced.segmentTitle')}
            description={t('settings.advanced.segmentDescription')}
            value={advanced.maxSegmentSec}
            min={4}
            max={30}
            step={1}
            format={seconds}
            onCommit={(v) => save({ advanced: { maxSegmentSec: v } })}
          />
          <Divider />
          <SliderSetting
            title={t('settings.advanced.cooldownTitle')}
            description={t('settings.advanced.cooldownDescription')}
            value={Math.min(60, advanced.autoSuggestCooldownSec)}
            min={0}
            max={60}
            step={1}
            format={seconds}
            onCommit={(v) => save({ advanced: { autoSuggestCooldownSec: v } })}
          />
          <Divider />
          <SliderSetting
            title={t('settings.advanced.contextTitle')}
            description={t('settings.advanced.contextDescription')}
            value={advanced.contextMinutes}
            min={1}
            max={30}
            step={1}
            format={(v) => t('settings.advanced.minutes', { n: Math.round(v) })}
            onCommit={(v) => save({ advanced: { contextMinutes: v } })}
          />
          <Divider />
          <div className="flex items-center gap-6 py-3">
            <div className="min-w-0 flex-1">
              <div className="text-[13.5px] font-medium text-fg">
                {t('settings.advanced.devLoggingTitle')}
              </div>
              <div className="mt-0.5 text-[12.5px] text-muted">
                {t('settings.advanced.devLoggingDescription')}
              </div>
            </div>
            <Switch
              checked={advanced.devLogging}
              onCheckedChange={(v) => void save({ advanced: { devLogging: v } })}
              label={t('settings.advanced.devLoggingTitle')}
            />
          </div>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <Button
            size="sm"
            variant="ghost"
            icon={<RotateCcw size={13} />}
            loading={resetting}
            onClick={() => void reset()}
          >
            {t('settings.advanced.reset')}
          </Button>
          {error || resetError ? <StatusLine tone="error">{error ?? resetError}</StatusLine> : null}
        </div>
      </Collapsible.Content>
    </Collapsible.Root>
  )
}

export function GeneralPage() {
  const general = useSettings((s) => s.settings.general)
  const { save, error } = useSave()

  const themeOptions: SelectOption<ThemePreference>[] = [
    { value: 'system', label: t('settings.theme.system') },
    { value: 'light', label: t('settings.theme.light') },
    { value: 'dark', label: t('settings.theme.dark') },
  ]

  return (
    <div>
      <PageHeader title={t('settings.general.title')} subtitle={t('settings.general.subtitle')} />
      <div className="-mt-3">
        <UpdateRow />
        <ActiveModeRow />
        <SettingsRow
          icon={<Palette size={18} />}
          title={t('settings.general.themeTitle')}
          description={t('settings.general.themeDescription')}
          control={
            <Select
              value={general.theme}
              onValueChange={(theme) => void save({ general: { theme } })}
              options={themeOptions}
              label={t('settings.general.themeTitle')}
              className="w-[150px]"
            />
          }
        />
        <SettingsRow
          icon={<Power size={18} />}
          title={t('settings.general.startupTitle')}
          description={t('settings.general.startupDescription')}
          control={
            <Switch
              checked={general.launchAtStartup}
              onCheckedChange={(v) => void save({ general: { launchAtStartup: v } })}
              label={t('settings.general.startupTitle')}
            />
          }
        />
        <SettingsRow
          icon={<MessageSquareText size={18} />}
          title={t('settings.general.consentTitle')}
          description={t('settings.general.consentDescription')}
          control={
            <Switch
              checked={general.consentReminder}
              onCheckedChange={(v) => void save({ general: { consentReminder: v } })}
              label={t('settings.general.consentTitle')}
            />
          }
        />
        <SettingsRow
          icon={<Sparkles size={18} />}
          title={t('settings.general.autoSuggestTitle')}
          description={t('settings.general.autoSuggestDescription')}
          control={
            <Switch
              checked={general.autoSuggest}
              onCheckedChange={(v) => void save({ general: { autoSuggest: v } })}
              label={t('settings.general.autoSuggestTitle')}
            />
          }
        />
        {error ? <StatusLine tone="error">{error}</StatusLine> : null}
      </div>

      <SettingsSection
        title={t('settings.general.audioTitle')}
        description={t('settings.general.audioSubtitle')}
        className="mt-6"
      >
        <div className="mt-3">
          <AudioSetupCard />
        </div>
      </SettingsSection>

      <AdvancedSection />
    </div>
  )
}
