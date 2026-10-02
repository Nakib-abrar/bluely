import { CircleCheck, Layers, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { t } from '@shared/i18n'
import type { InvokeRequest } from '@shared/ipc'
import type { Mode, ModelRole, Tone } from '@shared/types'
import {
  Badge,
  Button,
  cn,
  ConfirmDialog,
  EmptyState,
  Input,
  Select,
  Spinner,
  Switch,
  Textarea,
  type SelectOption,
} from '../../components/ui'
import { invoke } from '../../lib/ipc'
import { useSettings } from '../../stores/settings'
import { FieldLabel, PageHeader, SaveIndicator, StatusLine } from '../components/bits'
import { KnowledgeFiles } from '../components/KnowledgeFiles'
import { ModelPicker } from '../components/ModelPicker'
import { useDebouncedSave } from '../hooks'
import { describeError } from '../lib/errors'
import { modelLabel } from '../lib/models'
import { isValidModeIcon } from '../lib/text'
import { useActiveModeId, useModelCatalog, useModes } from '../stores'

type ModeInput = InvokeRequest<'modes:create'>

const NEW_MODE: ModeInput = {
  name: '',
  icon: '✨',
  instructions: '',
  tone: 'concise',
  autoSuggest: true,
  modelOverrides: {},
}

function ModeListItem({
  mode,
  selected,
  active,
  onSelect,
}: {
  mode: Mode
  selected: boolean
  active: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'no-drag flex w-full items-center gap-2.5 rounded-[10px] px-2 py-2 text-left transition-colors duration-150',
        selected ? 'bg-panel-3' : 'hover:bg-panel-2',
      )}
    >
      <span
        aria-hidden="true"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-line bg-panel-2 text-[16px]"
      >
        {mode.icon || '•'}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            'block truncate text-[13px]',
            selected ? 'font-medium text-fg' : 'text-fg/90',
          )}
        >
          {mode.name}
        </span>
        {mode.isBuiltin ? (
          <span className="block text-[11px] text-subtle">{t('settings.modes.builtin')}</span>
        ) : null}
      </span>
      {active ? (
        <CircleCheck
          size={15}
          className="shrink-0 text-accent-text"
          aria-label={t('settings.modes.active')}
        />
      ) : null}
    </button>
  )
}

function ModeEditor({
  mode,
  active,
  autoFocusName,
  onSetActive,
  onReset,
  onDelete,
}: {
  mode: Mode
  active: boolean
  autoFocusName: boolean
  onSetActive: () => void
  onReset: () => void
  onDelete: () => void
}) {
  const upsert = useModes((s) => s.upsert)
  const roleModels = useSettings((s) => s.settings.models)
  const catalog = useModelCatalog((s) => s.models)
  const [name, setName] = useState(mode.name)
  const [icon, setIcon] = useState(mode.icon)
  const [instructions, setInstructions] = useState(mode.instructions)
  const [tone, setTone] = useState<Tone>(mode.tone)
  const [autoSuggest, setAutoSuggest] = useState(mode.autoSuggest)
  const [overrides, setOverrides] = useState<Partial<Record<ModelRole, string>>>(
    mode.modelOverrides,
  )

  const autosave = useDebouncedSave<Partial<ModeInput>>(async (patch) => {
    try {
      upsert(await invoke('modes:update', { id: mode.id, patch }))
    } catch (err) {
      throw new Error(describeError(err))
    }
  })

  const nameValid = name.trim().length > 0 && name.trim().length <= 80
  const iconValid = isValidModeIcon(icon)

  const toneOptions: SelectOption<Tone>[] = [
    { value: 'concise', label: t('settings.modes.toneConcise') },
    { value: 'friendly', label: t('settings.modes.toneFriendly') },
    { value: 'formal', label: t('settings.modes.toneFormal') },
  ]

  const setOverride = (role: ModelRole, id: string) => {
    const next = { ...overrides }
    if (id) next[role] = id
    else delete next[role]
    setOverrides(next)
    autosave.schedule({ modelOverrides: next })
  }

  return (
    <div className="animate-fade-in" data-testid="mode-editor">
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-line bg-panel-2 text-[22px]"
        >
          {icon.trim() || '•'}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold text-fg">
            {name.trim() || t('settings.modes.newName')}
          </div>
          <div className="mt-0.5 flex items-center gap-2">
            {active ? <Badge tone="accent">{t('settings.modes.active')}</Badge> : null}
            {mode.isBuiltin ? <Badge>{t('settings.modes.builtin')}</Badge> : null}
            <SaveIndicator state={autosave.state} />
          </div>
        </div>
        {active ? null : (
          <Button variant="primary" size="sm" onClick={onSetActive}>
            {t('settings.modes.setActive')}
          </Button>
        )}
      </div>
      {autosave.state === 'error' && autosave.error ? (
        <StatusLine tone="error" className="mt-2">
          {t('settings.saveFailed', { error: autosave.error })}
        </StatusLine>
      ) : null}

      <div className="mt-4 grid grid-cols-[1fr_88px] gap-3">
        <div>
          <FieldLabel htmlFor="mode-name">{t('settings.modes.name')}</FieldLabel>
          <Input
            id="mode-name"
            value={name}
            maxLength={80}
            autoFocus={autoFocusName}
            invalid={!nameValid}
            placeholder={t('settings.modes.newName')}
            onChange={(e) => {
              setName(e.target.value)
              if (e.target.value.trim()) autosave.schedule({ name: e.target.value.trim() })
            }}
          />
        </div>
        <div>
          <FieldLabel htmlFor="mode-icon">{t('settings.modes.icon')}</FieldLabel>
          <Input
            id="mode-icon"
            value={icon}
            maxLength={16}
            invalid={!iconValid}
            title={t('settings.modes.iconHint')}
            className="text-[16px]!"
            style={{ textAlign: 'center' }}
            onChange={(e) => {
              setIcon(e.target.value)
              if (isValidModeIcon(e.target.value))
                autosave.schedule({ icon: e.target.value.trim() })
            }}
          />
        </div>
      </div>

      <div className="mt-3">
        <FieldLabel htmlFor="mode-instructions">{t('settings.modes.instructions')}</FieldLabel>
        <Textarea
          id="mode-instructions"
          rows={8}
          maxLength={8000}
          value={instructions}
          placeholder={t('settings.modes.instructionsPlaceholder')}
          onChange={(e) => {
            setInstructions(e.target.value)
            autosave.schedule({ instructions: e.target.value })
          }}
        />
      </div>

      <div className="mt-3 flex items-end gap-4">
        <div>
          <FieldLabel>{t('settings.modes.tone')}</FieldLabel>
          <Select
            value={tone}
            onValueChange={(v) => {
              setTone(v)
              autosave.schedule({ tone: v })
            }}
            options={toneOptions}
            label={t('settings.modes.tone')}
            className="w-[150px]"
          />
        </div>
        <label className="flex h-9 flex-1 items-center justify-between gap-3 rounded-[10px] border border-line bg-panel-2 px-3">
          <span className="min-w-0">
            <span className="block text-[13px] text-fg">{t('settings.modes.autoSuggest')}</span>
          </span>
          <Switch
            checked={autoSuggest}
            onCheckedChange={(v) => {
              setAutoSuggest(v)
              autosave.schedule({ autoSuggest: v })
            }}
            label={t('settings.modes.autoSuggestDescription')}
          />
        </label>
      </div>

      <div className="mt-5">
        <div className="text-[13.5px] font-semibold text-fg">{t('settings.modes.overrides')}</div>
        <div className="mt-0.5 text-[12px] text-muted">{t('settings.modes.overridesSubtitle')}</div>
        <div className="mt-2.5 flex flex-col gap-2">
          {(['fast', 'smart', 'notes'] as const).map((role) => {
            const roleTitle =
              role === 'fast'
                ? t('settings.models.roleFast')
                : role === 'smart'
                  ? t('settings.models.roleSmart')
                  : t('settings.models.roleNotes')
            return (
              <div key={role} className="flex items-center gap-3">
                <span className="w-[56px] shrink-0 text-[12.5px] text-muted">{roleTitle}</span>
                <ModelPicker
                  role={role}
                  value={overrides[role] ?? ''}
                  onChange={(id) => setOverride(role, id)}
                  label={t('settings.models.pickerLabel', { role: roleTitle })}
                  defaultLabel={t('settings.picker.useDefaultNamed', {
                    model: modelLabel(catalog, roleModels[role].model),
                  })}
                  className="min-w-0 flex-1"
                />
              </div>
            )
          })}
        </div>
      </div>

      <div className="mt-6">
        <div className="text-[13.5px] font-semibold text-fg">{t('settings.knowledge.title')}</div>
        <div className="mt-0.5 mb-2.5 text-[12px] text-muted">
          {t('settings.knowledge.subtitle')}
        </div>
        <KnowledgeFiles key={mode.id} modeId={mode.id} />
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-line pt-4">
        {mode.isBuiltin ? (
          <Button size="sm" icon={<RotateCcw size={13} />} onClick={onReset}>
            {t('settings.modes.resetBuiltin')}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            icon={<Trash2 size={13} />}
            onClick={onDelete}
            className="text-danger! hover:bg-danger-soft!"
          >
            {t('settings.modes.delete')}
          </Button>
        )}
      </div>
    </div>
  )
}

export function ModesPage() {
  const { modes, status, error, load, upsert, remove, setActive: makeActive } = useModes()
  const activeId = useActiveModeId()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editorVersion, setEditorVersion] = useState(0)
  const [justCreated, setJustCreated] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<'reset' | 'delete' | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void load()
  }, [load])

  const selected =
    modes.find((m) => m.id === selectedId) ??
    modes.find((m) => m.id === activeId) ??
    modes[0] ??
    null

  const run = async (action: () => Promise<void>) => {
    setActionError(null)
    setBusy(true)
    try {
      await action()
    } catch (err) {
      setActionError(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  const create = () =>
    run(async () => {
      setCreating(true)
      try {
        const mode = await invoke('modes:create', {
          ...NEW_MODE,
          name: t('settings.modes.newName'),
        })
        upsert(mode)
        setSelectedId(mode.id)
        setJustCreated(mode.id)
      } finally {
        setCreating(false)
      }
    })

  const setActive = (id: string) => run(() => makeActive(id))

  const resetSelected = () =>
    run(async () => {
      if (!selected) return
      upsert(await invoke('modes:resetBuiltin', { id: selected.id }))
      setEditorVersion((v) => v + 1)
      setConfirm(null)
    })

  const deleteSelected = () =>
    run(async () => {
      if (!selected) return
      await invoke('modes:delete', { id: selected.id })
      remove(selected.id)
      setSelectedId(null)
      setConfirm(null)
    })

  return (
    <div>
      <PageHeader
        title={t('settings.modes.title')}
        subtitle={t('settings.modes.subtitle')}
        actions={
          <Button
            size="sm"
            icon={<Plus size={14} />}
            onClick={() => void create()}
            loading={creating}
            disabled={status !== 'ready'}
          >
            {t('settings.modes.new')}
          </Button>
        }
      />
      {actionError ? (
        <StatusLine tone="error" className="-mt-2 mb-3">
          {actionError}
        </StatusLine>
      ) : null}

      {status === 'error' && !modes.length ? (
        <EmptyState
          icon={<Layers size={28} />}
          title={t('settings.modes.loadError', { error: error ?? '' })}
          action={<Button onClick={() => void load()}>{t('settings.picker.retry')}</Button>}
        />
      ) : !modes.length ? (
        <div className="flex justify-center py-16 text-subtle">
          <Spinner size={18} />
        </div>
      ) : (
        <div className="flex items-start gap-5">
          <nav
            aria-label={t('settings.modes.listLabel')}
            className="flex w-[200px] shrink-0 flex-col gap-0.5"
            data-testid="mode-list"
          >
            {modes.map((m) => (
              <ModeListItem
                key={m.id}
                mode={m}
                selected={m.id === selected?.id}
                active={m.id === activeId}
                onSelect={() => setSelectedId(m.id)}
              />
            ))}
          </nav>
          <section className="min-w-0 flex-1">
            {selected ? (
              <ModeEditor
                key={`${selected.id}:${editorVersion}`}
                mode={selected}
                active={selected.id === activeId}
                autoFocusName={justCreated === selected.id}
                onSetActive={() => void setActive(selected.id)}
                onReset={() => setConfirm('reset')}
                onDelete={() => setConfirm('delete')}
              />
            ) : (
              <p className="py-10 text-center text-[13px] text-muted">
                {t('settings.modes.empty')}
              </p>
            )}
          </section>
        </div>
      )}

      <ConfirmDialog
        open={confirm === 'reset'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={t('settings.modes.resetTitle', { name: selected?.name ?? '' })}
        description={t('settings.modes.resetDescription')}
        confirmLabel={t('settings.modes.resetBuiltin')}
        busy={busy}
        onConfirm={() => void resetSelected()}
      />
      <ConfirmDialog
        open={confirm === 'delete'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={t('settings.modes.deleteTitle', { name: selected?.name ?? '' })}
        description={t('settings.modes.deleteDescription')}
        confirmLabel={t('settings.modes.delete')}
        danger
        busy={busy}
        onConfirm={() => void deleteSelected()}
      />
    </div>
  )
}
