import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, Check, Copy, Mail } from 'lucide-react'
import { t } from '@shared/i18n'
import type { FollowUpEmail, SessionDetail } from '@shared/types'
import { Button, Input, Label, Spinner, Textarea } from '../../components/ui'
import { errorMessage, invoke } from '../../lib/ipc'
import { emailToText } from '../lib/copyText'
import { toast } from '../stores/toast'

export const EMAIL_AUTOSAVE_MS = 600

type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error'

export interface EmailTabProps {
  detail: SessionDetail
  patch(fn: (d: SessionDetail) => SessionDetail): void
}

function SaveIndicator({ state }: { state: SaveState }) {
  if (state === 'pending' || state === 'saving')
    return (
      <span className="inline-flex items-center gap-1.5 text-[12px] text-subtle" role="status">
        <Spinner size={11} />
        {t('session.email.saving')}
      </span>
    )
  if (state === 'saved')
    return (
      <span className="inline-flex items-center gap-1 text-[12px] text-subtle" role="status">
        <Check size={12} className="text-success" />
        {t('session.email.saved')}
      </span>
    )
  if (state === 'error')
    return (
      <span className="inline-flex items-center gap-1 text-[12px] text-danger" role="alert">
        <AlertCircle size={12} />
        {t('session.email.saveFailed')}
      </span>
    )
  return null
}

/** Editable follow-up email; autosaves 600 ms after the last keystroke. */
export function EmailTab({ detail, patch }: EmailTabProps) {
  const id = detail.id
  // Local draft while editing: a server refresh must never overwrite what is being typed.
  const [draft, setDraft] = useState<FollowUpEmail | null>(null)
  const [save, setSave] = useState<SaveState>('idle')
  const email = draft ?? detail.email ?? { subject: '', body: '' }
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = useRef<FollowUpEmail>(email)

  const persist = useCallback(
    (next: FollowUpEmail) =>
      invoke('sessions:updateEmail', { id, subject: next.subject, body: next.body }).then(() =>
        patch((d) => ({ ...d, email: next })),
      ),
    [id, patch],
  )

  const change = (next: FollowUpEmail) => {
    setDraft(next)
    setSave('pending')
    latest.current = next
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      setSave('saving')
      persist(next)
        .then(() => setSave((s) => (s === 'saving' ? 'saved' : s)))
        .catch(() => setSave('error'))
    }, EMAIL_AUTOSAVE_MS)
  }

  /** Saves immediately if a debounced save is still waiting. */
  const flush = useCallback(async () => {
    if (!timer.current) return
    clearTimeout(timer.current)
    timer.current = null
    await persist(latest.current)
  }, [persist])

  // Leaving the tab (or the page) must not lose the last keystrokes.
  useEffect(() => {
    const pending = timer
    const last = latest
    return () => {
      if (!pending.current) return
      clearTimeout(pending.current)
      pending.current = null
      persist(last.current).catch((err: unknown) =>
        toast(`${t('session.email.saveFailed')}: ${errorMessage(err)}`, 'error'),
      )
    }
  }, [persist])

  const copy = () => {
    invoke('clipboard:writeText', { text: emailToText(email) })
      .then(() => toast(t('session.email.copied'), 'success'))
      .catch((err: unknown) => toast(errorMessage(err), 'error'))
  }

  const openMail = () => {
    flush()
      .then(() => invoke('sessions:openMailDraft', { id }))
      .catch((err: unknown) =>
        toast(`${t('session.email.openFailed')}: ${errorMessage(err)}`, 'error'),
      )
  }

  const generating = !detail.email && !draft && detail.status === 'processing'

  return (
    <div data-testid="email-tab">
      <div className="mb-4 flex min-h-8 items-center gap-2">
        {generating ? (
          <span className="inline-flex items-center gap-2 text-[13px] text-muted" role="status">
            <Spinner size={13} className="text-accent-2" />
            {t('session.email.generating')}
          </span>
        ) : !detail.email && !draft ? (
          <span className="text-[13px] text-subtle">{t('session.email.emptyHint')}</span>
        ) : (
          <SaveIndicator state={save} />
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="secondary" icon={<Copy size={13} />} onClick={copy}>
            {t('session.email.copy')}
          </Button>
          <Button size="sm" variant="primary" icon={<Mail size={13} />} onClick={openMail}>
            {t('session.email.openMail')}
          </Button>
        </div>
      </div>
      <div className="rounded-xl border border-line bg-panel p-4">
        <Label htmlFor="email-subject">{t('session.email.subject')}</Label>
        <Input
          id="email-subject"
          value={email.subject}
          placeholder={t('session.email.subjectPlaceholder')}
          onChange={(e) => change({ ...email, subject: e.target.value })}
          className="mb-4"
        />
        <Label htmlFor="email-body">{t('session.email.body')}</Label>
        <Textarea
          id="email-body"
          value={email.body}
          placeholder={t('session.email.bodyPlaceholder')}
          onChange={(e) => change({ ...email, body: e.target.value })}
          rows={14}
          className="min-h-[280px]"
        />
      </div>
    </div>
  )
}
