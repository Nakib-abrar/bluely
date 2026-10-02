/**
 * OpenRouter API key block (status, paste + save, test connection, remove, "Get a key").
 * Used by Settings › AI Models and onboarding step 1. The key itself never comes back to the
 * renderer: main only returns a masked form.
 */
import { Eye, EyeOff, KeyRound, PlugZap, Trash2 } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { OPENROUTER_KEYS_URL } from '@shared/constants'
import { t } from '@shared/i18n'
import type { KeyStatus, KeyTestResult } from '@shared/types'
import { Button, Card, cn, ConfirmDialog, Input } from '../../components/ui'
import { invoke } from '../../lib/ipc'
import { describeError } from '../lib/errors'
import { describeKeyTest } from '../lib/text'
import { ExternalLinkButton, StatusLine } from './bits'

type TestState =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'done'; result: KeyTestResult }
  | { kind: 'error'; message: string }

export function KeyBlock({
  onTestResult,
  autoFocus,
  className,
}: {
  /** Called after every connection test (onboarding enables Next on success). */
  onTestResult?: (ok: boolean) => void
  autoFocus?: boolean
  className?: string
}) {
  const [status, setStatus] = useState<KeyStatus | null>(null)
  const [draft, setDraft] = useState('')
  const [reveal, setReveal] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [test, setTest] = useState<TestState>({ kind: 'idle' })
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [removing, setRemoving] = useState(false)

  useEffect(() => {
    let alive = true
    invoke('key:getStatus')
      .then((s) => alive && setStatus(s))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  const runTest = async () => {
    setTest({ kind: 'testing' })
    try {
      const result = await invoke('key:test')
      setTest({ kind: 'done', result })
      onTestResult?.(result.ok)
    } catch (err) {
      setTest({ kind: 'error', message: describeError(err) })
      onTestResult?.(false)
    }
  }

  const trimmed = draft.trim()
  const canSave = trimmed.length >= 10 && !saving

  const save = async (e?: FormEvent) => {
    e?.preventDefault()
    if (!canSave) return
    setSaving(true)
    setSaveError(null)
    try {
      const next = await invoke('key:set', { key: trimmed })
      setStatus(next)
      setDraft('')
      setReveal(false)
      // Saving is only useful with a working key, so check it right away.
      void runTest()
    } catch (err) {
      setSaveError(describeError(err))
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    setRemoving(true)
    try {
      setStatus(await invoke('key:clear'))
      setTest({ kind: 'idle' })
      onTestResult?.(false)
      setConfirmRemove(false)
    } catch (err) {
      setSaveError(describeError(err))
      setConfirmRemove(false)
    } finally {
      setRemoving(false)
    }
  }

  const hasKey = !!status?.hasKey
  const looksWrong = trimmed.length >= 6 && !trimmed.startsWith('sk-or-')

  return (
    <Card className={cn('p-0!', className)}>
      <div className="flex items-start gap-3.5 px-4 pt-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] border border-line bg-panel-3 text-muted">
          <KeyRound size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-medium text-fg">{t('settings.key.title')}</div>
          <div
            className="mt-0.5 flex items-center gap-1.5 text-[12.5px] text-muted"
            data-testid="key-status"
          >
            <span
              aria-hidden="true"
              className={cn('h-1.5 w-1.5 rounded-full', hasKey ? 'bg-success' : 'bg-warning')}
            />
            <span className="tabular truncate">
              {hasKey
                ? t('settings.key.saved', { masked: status?.masked ?? '' })
                : t('settings.key.noKey')}
            </span>
          </div>
        </div>
        <ExternalLinkButton href={OPENROUTER_KEYS_URL} className="mt-0.5 shrink-0">
          {t('settings.key.getKey')}
        </ExternalLinkButton>
      </div>

      <form onSubmit={(e) => void save(e)} className="mt-3.5 flex items-center gap-2 px-4">
        <Input
          type={reveal ? 'text' : 'password'}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value)
            setSaveError(null)
          }}
          placeholder={t('settings.key.placeholder')}
          aria-label={t('settings.key.inputLabel')}
          autoComplete="off"
          spellCheck={false}
          autoFocus={autoFocus}
          className="flex-1 font-mono"
          invalid={!!saveError}
          right={
            <button
              type="button"
              aria-label={reveal ? t('settings.key.hide') : t('settings.key.show')}
              onClick={() => setReveal((v) => !v)}
              className="-mr-1 inline-flex h-7 w-7 items-center justify-center rounded-md text-subtle hover:bg-panel-3 hover:text-fg"
            >
              {reveal ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          }
        />
        <Button
          type="submit"
          variant={trimmed ? 'primary' : 'secondary'}
          disabled={!canSave}
          loading={saving}
        >
          {hasKey ? t('settings.key.replace') : t('settings.key.save')}
        </Button>
      </form>
      {status && !status.encryptionAvailable ? (
        <StatusLine tone="error" className="mt-2 px-4">
          {t('settings.key.noEncryption')}
        </StatusLine>
      ) : null}
      {saveError ? (
        <StatusLine tone="error" className="mt-2 px-4">
          {saveError}
        </StatusLine>
      ) : looksWrong ? (
        <StatusLine tone="info" className="mt-2 px-4">
          {t('settings.key.format')}
        </StatusLine>
      ) : null}

      <div className="mt-3.5 flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">
        <Button
          size="sm"
          icon={<PlugZap size={13} />}
          onClick={() => void runTest()}
          disabled={!hasKey}
          loading={test.kind === 'testing'}
        >
          {test.kind === 'testing' ? t('settings.key.testing') : t('settings.key.test')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon={<Trash2 size={13} />}
          onClick={() => setConfirmRemove(true)}
          disabled={!hasKey}
          className="hover:text-danger"
        >
          {t('settings.key.remove')}
        </Button>
        <div className="min-w-0 flex-1 pl-1" data-testid="key-test-result">
          {test.kind === 'done' ? (
            test.result.ok ? (
              <StatusLine tone="success">{describeKeyTest(test.result)}</StatusLine>
            ) : (
              <StatusLine tone="error">
                {test.result.error?.message ?? t('errors.unknown')}
              </StatusLine>
            )
          ) : test.kind === 'error' ? (
            <StatusLine tone="error">{test.message}</StatusLine>
          ) : null}
        </div>
      </div>

      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={t('settings.key.removeTitle')}
        description={t('settings.key.removeDescription')}
        confirmLabel={t('settings.key.remove')}
        danger
        busy={removing}
        onConfirm={() => void remove()}
      />
    </Card>
  )
}
