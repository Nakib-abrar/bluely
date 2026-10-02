import { AudioLines, Eye, Gauge, NotebookPen, Plus, RefreshCw, Wallet, X, Zap } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { OPENROUTER_CREDITS_URL } from '@shared/constants'
import { t } from '@shared/i18n'
import type { DeepPartial, Settings } from '@shared/settings'
import type {
  LatencyTestProgress,
  ModelRole,
  ModelStat,
  ModelValidationResult,
  MonthSpend,
  ProviderSort,
  RoleConfig,
} from '@shared/types'
import {
  Banner,
  Button,
  Card,
  cn,
  IconButton,
  Input,
  Select,
  SettingsSection,
  Spinner,
  Switch,
  type SelectOption,
} from '../../components/ui'
import { useIpcEvent } from '../../hooks/useIpcEvent'
import { invoke } from '../../lib/ipc'
import { useSettings } from '../../stores/settings'
import { ExternalLinkButton, PageHeader, Section, StatusLine } from '../components/bits'
import { KeyBlock } from '../components/KeyBlock'
import { ModelBadges, ModelPicker } from '../components/ModelPicker'
import { describeError, isNotImplemented } from '../lib/errors'
import {
  defaultLatencySelection,
  formatMs,
  modelLabel,
  modelMeta,
  parseProviderOrder,
  shortModelLabel,
  type PickerRole,
} from '../lib/models'
import { describeSpend } from '../lib/text'
import { useModelCatalog } from '../stores'

const MAX_LATENCY_MODELS = 8
const LATENCY_RUNS = 5

function roleInfo(role: PickerRole): { title: string; description: string; icon: ReactNode } {
  return ROLE_INFO[role]()
}

const ROLE_INFO: Record<PickerRole, () => { title: string; description: string; icon: ReactNode }> =
  {
    fast: () => ({
      title: t('settings.models.roleFast'),
      description: t('settings.models.roleFastDescription'),
      icon: <Zap size={18} />,
    }),
    smart: () => ({
      title: t('settings.models.roleSmart'),
      description: t('settings.models.roleSmartDescription'),
      icon: <Eye size={18} />,
    }),
    notes: () => ({
      title: t('settings.models.roleNotes'),
      description: t('settings.models.roleNotesDescription'),
      icon: <NotebookPen size={18} />,
    }),
    stt: () => ({
      title: t('settings.models.roleStt'),
      description: t('settings.models.roleSttDescription'),
      icon: <AudioLines size={18} />,
    }),
  }

function useSave() {
  const update = useSettings((s) => s.update)
  const [error, setError] = useState<string | null>(null)
  const save = (patch: DeepPartial<Settings>) =>
    update(patch)
      .then(() => setError(null))
      .catch((err: unknown) => setError(t('settings.saveFailed', { error: describeError(err) })))
  return { save, error }
}

function ValidationNotices() {
  const [results, setResults] = useState<ModelValidationResult[]>([])
  useEffect(() => {
    let alive = true
    invoke('models:validateDefaults')
      .then((r) => alive && setResults(r.filter((x) => x.replaced)))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])
  if (!results.length) return null
  return (
    <div className="mb-5 flex flex-col gap-2" data-testid="model-validation">
      {results.map((r) => (
        <Banner
          key={r.role}
          tone="warning"
          title={t('settings.models.replaced', {
            role: roleInfo(r.role).title,
            requested: r.requested,
            resolved: r.resolved,
          })}
        >
          {r.reason}
        </Banner>
      ))}
    </div>
  )
}

function RoutingControls({
  role,
  config,
  onSave,
}: {
  role: ModelRole
  config: RoleConfig
  onSave: (patch: Partial<RoleConfig>) => void
}) {
  const sortOptions: SelectOption<ProviderSort>[] = [
    { value: 'latency', label: t('settings.models.sortLatency') },
    { value: 'price', label: t('settings.models.sortPrice') },
    { value: 'throughput', label: t('settings.models.sortThroughput') },
  ]
  const orderText = config.order.join(', ')
  const commitOrder = (text: string) => {
    const order = parseProviderOrder(text)
    if (order.join(',') !== config.order.join(',')) onSave({ order })
  }
  const pinId = `pin-${role}`
  return (
    <div className="flex flex-wrap items-end gap-x-4 gap-y-3 border-t border-line px-4 pt-3 pb-3.5">
      <div>
        <div className="mb-1.5 text-[12px] font-medium text-muted">
          {t('settings.models.sortLabel')}
        </div>
        <Select
          value={config.sort}
          onValueChange={(sort) => onSave({ sort })}
          options={sortOptions}
          label={`${roleInfo(role).title}: ${t('settings.models.sortLabel')}`}
          size="sm"
          className="w-[172px]"
        />
      </div>
      <div className="min-w-[160px] flex-1">
        <label htmlFor={pinId} className="mb-1.5 block text-[12px] font-medium text-muted">
          {t('settings.models.pinLabel')}
        </label>
        <Input
          // Uncontrolled + keyed by the saved value so outside changes (reset) show up.
          key={orderText}
          id={pinId}
          defaultValue={orderText}
          placeholder={t('settings.models.pinPlaceholder')}
          title={t('settings.models.pinHint')}
          onBlur={(e) => commitOrder(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitOrder(e.currentTarget.value)
          }}
          spellCheck={false}
          className="h-8! font-mono text-[12.5px]!"
        />
      </div>
      <label
        className="flex h-8 items-center gap-2 text-[12.5px] text-muted"
        title={t('settings.models.fallbacksHint')}
      >
        <Switch
          checked={config.allowFallbacks}
          onCheckedChange={(allowFallbacks) => onSave({ allowFallbacks })}
          label={`${roleInfo(role).title}: ${t('settings.models.fallbacks')}`}
        />
        {t('settings.models.fallbacks')}
      </label>
    </div>
  )
}

function RoleCard({
  role,
  value,
  onModel,
  routing,
}: {
  role: PickerRole
  value: string
  onModel: (id: string) => void
  routing?: ReactNode
}) {
  const info = roleInfo(role)
  const catalog = useModelCatalog((s) => s.models)
  const model = catalog.find((m) => m.id === value)
  return (
    <Card className="p-0!">
      <div className="px-4 py-3.5">
        <div className="flex items-start gap-3.5">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] border border-line bg-panel-3 text-muted">
            {info.icon}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-medium text-fg">{info.title}</div>
            <div className="mt-0.5 text-[12.5px] text-muted">{info.description}</div>
          </div>
          <ModelPicker
            role={role}
            value={value}
            onChange={onModel}
            label={t('settings.models.pickerLabel', { role: info.title })}
            className="w-[230px] shrink-0"
          />
        </div>
        <div className="mt-2 flex min-w-0 items-center gap-2 pl-[54px]">
          {model ? <ModelBadges model={model} /> : null}
          <span className="tabular min-w-0 truncate text-[11.5px] text-subtle" title={value}>
            {model ? modelMeta(model) : value}
          </span>
        </div>
      </div>
      {routing}
    </Card>
  )
}

interface StatRow {
  model: string
  stat: ModelStat | null
  progress?: { completed: number; total: number } | null
  errors?: string[]
}

function StatsTable({ rows, showErrors }: { rows: StatRow[]; showErrors?: boolean }) {
  const models = useModelCatalog((s) => s.models)
  const head = 'py-2 px-1.5 text-[11.5px] font-medium text-subtle whitespace-nowrap'
  const num = 'py-2 px-1.5 text-right tabular whitespace-nowrap'
  return (
    <div className="overflow-hidden rounded-xl border border-line">
      {/* Fixed layout keeps the numbers aligned and lets long model names truncate. */}
      <table className="w-full table-fixed border-collapse text-[12.5px]">
        <colgroup>
          <col />
          <col className="w-[66px]" />
          <col className="w-[66px]" />
          <col className="w-[66px]" />
          <col className="w-[44px]" />
          <col className="w-[92px]" />
          <col className="w-[44px]" />
          {showErrors ? <col className="w-[52px]" /> : null}
        </colgroup>
        <thead className="bg-panel-2">
          <tr className="border-b border-line">
            <th className={cn(head, 'pl-3 text-left')}>{t('settings.models.colModel')}</th>
            <th className={cn(head, 'text-right')}>{t('settings.models.colTtftP50')}</th>
            <th className={cn(head, 'text-right')}>{t('settings.models.colTtftP90')}</th>
            <th className={cn(head, 'text-right')}>{t('settings.models.colTotalP50')}</th>
            <th className={cn(head, 'text-right')}>{t('settings.models.colTokPerSec')}</th>
            <th className={cn(head, 'pl-3 text-left')}>{t('settings.models.colProvider')}</th>
            <th className={cn(head, 'text-right', !showErrors && 'pr-3')}>
              {t('settings.models.colSamples')}
            </th>
            {showErrors ? (
              <th className={cn(head, 'pr-3 text-right')}>{t('settings.models.colErrors')}</th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const s = row.stat
            const running = row.progress && !s
            return (
              <tr key={row.model} className="border-b border-line last:border-b-0">
                <td className="truncate py-2 pr-2 pl-3 text-left" title={row.model}>
                  <span className="font-medium text-fg">{shortModelLabel(models, row.model)}</span>
                </td>
                {running ? (
                  <td colSpan={6} className="px-1.5 py-2 text-left text-muted">
                    <span className="inline-flex items-center gap-2">
                      <Spinner size={12} className="text-accent-text" />
                      <span className="tabular">
                        {t('settings.models.progress', {
                          done: row.progress?.completed ?? 0,
                          total: row.progress?.total ?? LATENCY_RUNS,
                        })}
                      </span>
                    </span>
                  </td>
                ) : (
                  <>
                    <td className={cn(num, 'font-medium text-fg')}>{formatMs(s?.ttftP50)}</td>
                    <td className={cn(num, 'text-muted')}>{formatMs(s?.ttftP90)}</td>
                    <td className={cn(num, 'text-muted')}>{formatMs(s?.totalP50)}</td>
                    <td className={cn(num, 'text-muted')}>
                      {s?.tokensPerSecP50 != null ? Math.round(s.tokensPerSecP50) : '—'}
                    </td>
                    <td
                      className="truncate py-2 pr-1.5 pl-3 text-left text-muted"
                      title={s?.provider ?? undefined}
                    >
                      {s?.provider ?? '—'}
                    </td>
                    <td className={cn(num, 'text-muted', !showErrors && 'pr-3')}>
                      {s?.samples ?? '—'}
                    </td>
                  </>
                )}
                {showErrors ? (
                  <td
                    className={cn(num, 'pr-3', row.errors?.length ? 'text-danger' : 'text-subtle')}
                    title={row.errors?.join('\n') || undefined}
                  >
                    {row.errors?.length ?? 0}
                  </td>
                ) : null}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function LatencySection({ onFinished }: { onFinished: () => void }) {
  const roleModels = useSettings((s) => s.settings.models)
  const catalog = useModelCatalog((s) => s.models)
  const [selected, setSelected] = useState<string[]>(() =>
    defaultLatencySelection({
      fast: roleModels.fast.model,
      smart: roleModels.smart.model,
      notes: roleModels.notes.model,
    }),
  )
  const [runId, setRunId] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [testedModels, setTestedModels] = useState<string[]>([])
  // Progress can arrive before invoke() returns the runId, so buffer it per run.
  const [progressByRun, setProgressByRun] = useState<
    Record<string, Record<string, LatencyTestProgress>>
  >({})
  const finishedRef = useRef(onFinished)
  useEffect(() => {
    finishedRef.current = onFinished
  })

  useIpcEvent('models:latencyProgress', (p) => {
    setProgressByRun((prev) => ({ ...prev, [p.runId]: { ...prev[p.runId], [p.model]: p } }))
  })

  const progress = runId ? (progressByRun[runId] ?? {}) : {}
  const allDone =
    running &&
    runId != null &&
    testedModels.length > 0 &&
    testedModels.every((m) => {
      const p = progress[m]
      return p && (p.result != null || p.completed >= p.total)
    })

  useEffect(() => {
    if (!allDone) return
    // The run finished: stop the spinner and refresh the rolling averages.
    const timer = setTimeout(() => {
      setRunning(false)
      finishedRef.current()
    }, 0)
    return () => clearTimeout(timer)
  }, [allDone])

  const start = async () => {
    setError(null)
    setRunning(true)
    setTestedModels(selected)
    setRunId(null)
    try {
      const res = await invoke('models:runLatencyTest', { models: selected, runs: LATENCY_RUNS })
      setRunId(res.runId)
    } catch (err) {
      setRunning(false)
      setError(describeError(err))
    }
  }

  const rows: StatRow[] = (testedModels.length && runId ? testedModels : selected).map((model) => {
    const p = runId ? progress[model] : undefined
    return {
      model,
      stat: p?.result ?? null,
      progress: running ? { completed: p?.completed ?? 0, total: p?.total ?? LATENCY_RUNS } : null,
      errors: p?.errors ?? [],
    }
  })

  return (
    <Section
      title={t('settings.models.latencySection')}
      description={t('settings.models.latencySubtitle')}
      className="mt-8"
      actions={
        <Button
          variant="primary"
          size="sm"
          icon={<Gauge size={14} />}
          loading={running}
          disabled={!selected.length}
          onClick={() => void start()}
        >
          {running ? t('settings.models.latencyRunning') : t('settings.models.latencyRun')}
        </Button>
      }
    >
      <div className="mt-3 flex flex-wrap items-center gap-2" data-testid="latency-models">
        {selected.map((id) => (
          <span
            key={id}
            title={id}
            className="inline-flex h-8 max-w-[240px] items-center gap-1 rounded-full border border-line bg-panel-2 pr-1 pl-3 text-[12.5px] text-fg"
          >
            <span className="truncate">{shortModelLabel(catalog, id)}</span>
            <IconButton
              size="sm"
              shape="round"
              tooltip={false}
              label={t('settings.models.latencyRemove', { model: modelLabel(catalog, id) })}
              icon={<X size={12} />}
              disabled={running}
              onClick={() => setSelected((s) => s.filter((m) => m !== id))}
              className="h-6 w-6"
            />
          </span>
        ))}
        {selected.length < MAX_LATENCY_MODELS ? (
          <ModelPicker
            role="fast"
            value=""
            exclude={selected}
            onChange={(id) => id && setSelected((s) => [...s, id].slice(0, MAX_LATENCY_MODELS))}
            label={t('settings.models.latencyAdd')}
            disabled={running}
            className="h-8! rounded-full! border-dashed text-[12.5px]! text-muted!"
            triggerContent={
              <span className="inline-flex items-center gap-1.5">
                <Plus size={13} />
                {t('settings.models.latencyAdd')}
              </span>
            }
          />
        ) : (
          <span className="text-[12px] text-subtle">{t('settings.models.latencyMax')}</span>
        )}
      </div>
      {error ? (
        <StatusLine tone="error" className="mt-2.5">
          {error}
        </StatusLine>
      ) : null}
      <div className="mt-3" data-testid="latency-table">
        {rows.length ? (
          <StatsTable rows={rows} showErrors />
        ) : (
          <p className="text-[12.5px] text-subtle">{t('settings.models.latencyEmpty')}</p>
        )}
      </div>
    </Section>
  )
}

function RollingSection({ stats, error }: { stats: ModelStat[] | null; error: string | null }) {
  return (
    <SettingsSection
      title={t('settings.models.rollingSection')}
      description={t('settings.models.rollingSubtitle')}
      className="mt-8"
    >
      <div className="mt-3" data-testid="rolling-table">
        {error ? (
          <StatusLine tone="error">{error}</StatusLine>
        ) : stats && stats.length ? (
          <StatsTable rows={stats.map((s) => ({ model: s.model, stat: s }))} />
        ) : (
          <p className="text-[12.5px] text-subtle">{t('settings.models.rollingEmpty')}</p>
        )}
      </div>
    </SettingsSection>
  )
}

function SpendSection() {
  const [spend, setSpend] = useState<MonthSpend | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    invoke('usage:getMonthSpend')
      .then((s) => alive && setSpend(s))
      .catch((err: unknown) => alive && setError(describeError(err)))
    return () => {
      alive = false
    }
  }, [])
  const text = spend ? describeSpend(spend) : null
  return (
    <SettingsSection
      title={t('settings.models.spendSection')}
      description={t('settings.models.spendSubtitle')}
      className="mt-8"
    >
      <Card className="mt-3 flex items-center gap-3.5">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] border border-line bg-panel-3 text-muted">
          <Wallet size={18} />
        </div>
        <div className="min-w-0 flex-1" data-testid="month-spend">
          {text ? (
            <>
              <div className="tabular text-[15px] font-semibold text-fg">{text.total}</div>
              <div className="tabular mt-0.5 text-[12.5px] text-muted">{text.detail}</div>
            </>
          ) : error ? (
            <div className="text-[12.5px] text-muted">{error}</div>
          ) : (
            <Spinner size={14} className="text-subtle" />
          )}
        </div>
        <ExternalLinkButton href={OPENROUTER_CREDITS_URL} className="shrink-0 text-[12.5px]">
          {t('settings.models.viewCredits')}
        </ExternalLinkButton>
      </Card>
    </SettingsSection>
  )
}

export function ModelsPage() {
  const models = useSettings((s) => s.settings.models)
  const { save, error } = useSave()
  const { status: catalogStatus, load } = useModelCatalog()
  const [stats, setStats] = useState<ModelStat[] | null>(null)
  const [statsError, setStatsError] = useState<string | null>(null)

  const loadStats = useCallback(() => {
    invoke('models:getStats')
      .then((s) => {
        setStats(s)
        setStatsError(null)
      })
      .catch((err: unknown) => {
        // Before the stats feature exists the table simply stays empty.
        if (!isNotImplemented(err)) setStatsError(describeError(err))
        else setStats([])
      })
  }, [])
  useEffect(() => {
    loadStats()
  }, [loadStats])

  const saveRole = (role: ModelRole, patch: Partial<RoleConfig>) =>
    void save({ models: { [role]: patch } })

  return (
    <div>
      <PageHeader title={t('settings.models.title')} subtitle={t('settings.models.subtitle')} />
      <ValidationNotices />

      <SettingsSection
        title={t('settings.models.keySection')}
        description={t('settings.models.keySectionSubtitle')}
      >
        <KeyBlock className="mt-3" />
      </SettingsSection>

      <Section
        title={t('settings.models.rolesSection')}
        description={t('settings.models.rolesSubtitle')}
        className="mt-8"
        actions={
          <Button
            size="sm"
            variant="ghost"
            icon={<RefreshCw size={13} />}
            loading={catalogStatus === 'loading'}
            onClick={() => void load({ refresh: true })}
          >
            {t('settings.models.refresh')}
          </Button>
        }
      >
        <div className="mt-3 flex flex-col gap-3">
          {(['fast', 'smart', 'notes'] as const).map((role) => (
            <RoleCard
              key={role}
              role={role}
              value={models[role].model}
              onModel={(id) => id && saveRole(role, { model: id })}
              routing={
                <RoutingControls
                  role={role}
                  config={models[role]}
                  onSave={(patch) => saveRole(role, patch)}
                />
              }
            />
          ))}
          <RoleCard
            role="stt"
            value={models.stt.model}
            onModel={(id) => id && void save({ models: { stt: { model: id } } })}
          />
        </div>
        {error ? (
          <StatusLine tone="error" className="mt-2.5">
            {error}
          </StatusLine>
        ) : null}
      </Section>

      <LatencySection onFinished={loadStats} />
      <RollingSection stats={stats} error={statsError} />
      <SpendSection />
    </div>
  )
}
