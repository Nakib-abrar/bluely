import { AppWindow, Globe, Info, RotateCcw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { t } from '@shared/i18n'
import {
  ALT_ENTER_PRESET,
  KEYBIND_DEFS,
  getKeybindDef,
  isValidAccelerator,
  keybindDisplay,
  keyEventToAccelerator,
  normalizeAccelerator,
  type KeybindId,
  type KeybindMap,
} from '@shared/keybinds'
import type { KeybindStatus } from '@shared/types'
import { Badge, Button, Card, cn, IconButton, Keys, Switch } from '../../components/ui'
import { useIpcEvent } from '../../hooks/useIpcEvent'
import { invoke } from '../../lib/ipc'
import { useSettings } from '../../stores/settings'
import { PageHeader, StatusLine } from '../components/bits'
import { describeError } from '../lib/errors'
import { describeRebindOutcome, evaluateRebind, labelOf, type RowMessage } from '../lib/rebind'

function heldModifiers(e: KeyboardEvent): string[] {
  const keys: string[] = []
  if (e.ctrlKey) keys.push('Ctrl')
  if (e.altKey) keys.push('Alt')
  if (e.shiftKey) keys.push('Shift')
  if (e.metaKey) keys.push('Win')
  return keys
}

function useKeybindStatus(): KeybindStatus[] {
  const [statuses, setStatuses] = useState<KeybindStatus[]>([])
  useEffect(() => {
    let alive = true
    invoke('keybinds:getStatus')
      .then((s) => alive && setStatuses(s))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])
  useIpcEvent('keybinds:status', setStatuses)
  return statuses
}

export function KeybindsPage() {
  const keybinds = useSettings((s) => s.settings.keybinds)
  const update = useSettings((s) => s.update)
  const statuses = useKeybindStatus()
  const [capturing, setCapturing] = useState<KeybindId | null>(null)
  const [held, setHeld] = useState<string[]>([])
  const [messages, setMessages] = useState<Partial<Record<KeybindId, RowMessage>>>({})
  const [pageError, setPageError] = useState<string | null>(null)
  const [resetting, setResetting] = useState(false)

  const setMessage = (id: KeybindId, msg: RowMessage | null) =>
    setMessages((m) => {
      const next = { ...m }
      if (msg) next[id] = msg
      else delete next[id]
      return next
    })

  const apply = async (patch: Partial<KeybindMap>) => {
    try {
      await update({ keybinds: patch })
      setPageError(null)
      return true
    } catch (err) {
      setPageError(t('settings.saveFailed', { error: describeError(err) }))
      return false
    }
  }

  /** Validates and saves a new accelerator for a bind. Returns true when it was saved. */
  const tryAssign = async (id: KeybindId, accelerator: string): Promise<boolean> => {
    const outcome = evaluateRebind(keybinds, id, accelerator)
    const msg = describeRebindOutcome(getKeybindDef(id), outcome)
    if (outcome.kind !== 'ok' && outcome.kind !== 'focusOnly') {
      setMessage(id, msg)
      return false
    }
    setMessage(id, msg)
    return apply({ [id]: outcome.accelerator })
  }

  const tryAssignRef = useRef(tryAssign)
  useEffect(() => {
    tryAssignRef.current = tryAssign
  })

  // Capture mode: listen on window in the capture phase so nothing else (the dialog's Esc
  // handler, focused buttons) sees the keys the user is recording.
  useEffect(() => {
    if (!capturing) return
    const def = getKeybindDef(capturing)
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()
      if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
        setCapturing(null)
        setHeld([])
        return
      }
      if (e.repeat) return
      const acc = keyEventToAccelerator(e, def.kind)
      if (!acc) {
        setHeld(heldModifiers(e))
        return
      }
      setHeld([])
      void tryAssignRef.current(def.id, acc).then((saved) => {
        if (saved) setCapturing((c) => (c === def.id ? null : c))
      })
    }
    const onKeyUp = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setHeld(heldModifiers(e))
    }
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
    }
  }, [capturing])

  const resetAll = async () => {
    setResetting(true)
    try {
      const next = await invoke('settings:reset', { section: 'keybinds' })
      useSettings.setState({ settings: next })
      setMessages({})
      setPageError(null)
    } catch (err) {
      setPageError(describeError(err))
    } finally {
      setResetting(false)
    }
  }

  const askIsAltEnter =
    keybinds.askAssist != null &&
    normalizeAccelerator(keybinds.askAssist) ===
      normalizeAccelerator(ALT_ENTER_PRESET.askAssist ?? '')

  return (
    <div>
      <PageHeader title={t('settings.keybinds.title')} subtitle={t('settings.keybinds.subtitle')} />

      <div className="overflow-hidden rounded-xl border border-line" data-testid="keybind-table">
        <div className="grid grid-cols-[1fr_190px_150px] items-center gap-3 border-b border-line bg-panel-2 px-4 py-2 text-[11.5px] font-medium text-subtle">
          <span>{t('settings.keybinds.colAction')}</span>
          <span>{t('settings.keybinds.colShortcut')}</span>
          <span />
        </div>
        {KEYBIND_DEFS.map((def) => {
          const value = keybinds[def.id]
          const status = statuses.find((s) => s.id === def.id)
          const label = labelOf(def.id)
          const isCapturing = capturing === def.id
          const valid = value != null && isValidAccelerator(value, def.kind)
          const taken =
            def.scope === 'global' &&
            valid &&
            status != null &&
            !status.registered &&
            status.accelerator != null &&
            normalizeAccelerator(status.accelerator) === normalizeAccelerator(value)
          const message = messages[def.id]
          return (
            <div
              key={def.id}
              data-testid={`keybind-${def.id}`}
              className={cn(
                'border-b border-line px-4 py-3 transition-colors duration-150 last:border-b-0',
                isCapturing && 'bg-accent-soft',
              )}
            >
              <div className="grid grid-cols-[1fr_190px_150px] items-center gap-3">
                <div className="min-w-0">
                  <div className="truncate text-[13.5px] font-medium text-fg">{label}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <span className="inline-flex items-center gap-1 text-[11.5px] text-subtle">
                      {def.scope === 'global' ? (
                        <Globe size={11} aria-hidden="true" />
                      ) : (
                        <AppWindow size={11} aria-hidden="true" />
                      )}
                      {def.scope === 'global' ? t('keybinds.global') : t('keybinds.local')}
                    </span>
                    {value == null ? (
                      <Badge>{t('settings.keybinds.disabled')}</Badge>
                    ) : !valid ? (
                      <Badge tone="danger">{t('settings.keybinds.invalid')}</Badge>
                    ) : taken ? (
                      <Badge tone="warning" title={status?.error ?? undefined}>
                        {status?.error ?? t('settings.keybinds.taken')}
                      </Badge>
                    ) : null}
                  </div>
                </div>
                <div className="min-w-0">
                  {isCapturing ? (
                    <span className="inline-flex h-7 items-center gap-1 rounded-lg border border-accent px-2 animate-pulse-dot">
                      {held.length ? <Keys keys={held} /> : null}
                      <span className="text-[12px] text-accent-text">…</span>
                    </span>
                  ) : value ? (
                    <Keys
                      keys={keybindDisplay(def.id, value)}
                      className={cn(!valid && 'opacity-60')}
                    />
                  ) : (
                    <span className="text-[12.5px] text-subtle">—</span>
                  )}
                </div>
                <div className="flex items-center justify-end gap-1.5">
                  <Button
                    size="sm"
                    variant={isCapturing ? 'ghost' : 'secondary'}
                    onClick={() => {
                      setHeld([])
                      setCapturing(isCapturing ? null : def.id)
                      if (!isCapturing) setMessage(def.id, null)
                    }}
                  >
                    {isCapturing ? t('settings.keybinds.cancel') : t('settings.keybinds.rebind')}
                  </Button>
                  <Switch
                    checked={value != null}
                    label={t('settings.keybinds.enable', { label })}
                    onCheckedChange={(on) => {
                      setCapturing(null)
                      if (on) void tryAssign(def.id, def.defaultAccelerator)
                      else {
                        setMessage(def.id, null)
                        void apply({ [def.id]: null })
                      }
                    }}
                  />
                  <IconButton
                    size="sm"
                    label={t('settings.keybinds.resetOne', { label })}
                    icon={<RotateCcw size={13} />}
                    disabled={value === def.defaultAccelerator}
                    onClick={() => {
                      setCapturing(null)
                      void tryAssign(def.id, def.defaultAccelerator)
                    }}
                  />
                </div>
              </div>
              {isCapturing ? (
                <div className="mt-1.5 text-[12px] text-accent-text" role="status">
                  {def.kind === 'single'
                    ? t('settings.keybinds.capture')
                    : t('settings.keybinds.captureArrows')}
                </div>
              ) : null}
              {message ? (
                <StatusLine tone={message.tone} className="mt-1.5">
                  {message.text}
                </StatusLine>
              ) : null}
            </div>
          )
        })}
      </div>

      {pageError ? (
        <StatusLine tone="error" className="mt-3">
          {pageError}
        </StatusLine>
      ) : null}

      <div className="mt-5" data-testid="alt-enter-preset">
        <Card className="flex items-center gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-[14px] font-medium text-fg">
              {t('settings.keybinds.presetTitle')}
              <Keys keys={['Alt', '↵']} />
            </div>
            <div className="mt-1 text-[12.5px] text-muted">
              {t('settings.keybinds.presetDescription')}
            </div>
          </div>
          <Button
            variant={askIsAltEnter ? 'secondary' : 'primary'}
            disabled={askIsAltEnter}
            onClick={() => void tryAssign('askAssist', ALT_ENTER_PRESET.askAssist ?? 'Alt+Enter')}
          >
            {askIsAltEnter
              ? t('settings.keybinds.presetActive')
              : t('settings.keybinds.presetApply')}
          </Button>
        </Card>
      </div>

      <div className="mt-4 flex items-start justify-between gap-4">
        <p className="flex items-start gap-2 text-[12.5px] text-muted">
          <Info size={14} className="mt-[2px] shrink-0 text-subtle" aria-hidden="true" />
          {t('settings.keybinds.moveNote')}
        </p>
        <Button
          size="sm"
          variant="ghost"
          icon={<RotateCcw size={13} />}
          loading={resetting}
          onClick={() => void resetAll()}
          className="shrink-0"
        >
          {t('settings.keybinds.resetAll')}
        </Button>
      </div>
    </div>
  )
}
