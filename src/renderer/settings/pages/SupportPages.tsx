import { BookOpen, Bug, Check, Copy, ExternalLink, Info, LifeBuoy, ShieldCheck } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { DOCS_URL, ISSUES_URL, RELEASES_URL, REPO_URL } from '@shared/constants'
import { t } from '@shared/i18n'
import { Badge, Button, Card, SettingsRow } from '../../components/ui'
import { invoke } from '../../lib/ipc'
import { ExternalLinkButton, PageHeader, StatusLine } from '../components/bits'
import { useAppInfo } from '../hooks'
import { describeError } from '../lib/errors'
import { formatAppInfo } from '../lib/text'
import { RELEASE_NOTES } from '../releaseNotes'

function formatReleaseDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00`)
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
}

export function ReleaseNotesPage() {
  const info = useAppInfo()
  return (
    <div>
      <PageHeader
        title={t('settings.releaseNotes.title')}
        subtitle={t('settings.releaseNotes.subtitle')}
        actions={
          <ExternalLinkButton href={RELEASES_URL} className="text-[12.5px]">
            {t('settings.releaseNotes.viewAll')}
          </ExternalLinkButton>
        }
      />
      <div className="flex flex-col gap-6">
        {RELEASE_NOTES.map((note) => (
          <article key={note.version} data-testid={`release-${note.version}`}>
            <div className="flex items-center gap-2.5">
              <h3 className="text-[15px] font-semibold text-fg">{note.title}</h3>
              <Badge tone="accent">v{note.version}</Badge>
              {info?.version === note.version ? (
                <Badge tone="success">{t('settings.releaseNotes.current')}</Badge>
              ) : null}
            </div>
            <div className="mt-0.5 text-[12.5px] text-subtle">{formatReleaseDate(note.date)}</div>
            <ul className="mt-3 flex flex-col gap-2.5">
              {note.highlights.map((h) => (
                <li key={h.title} className="rounded-xl border border-line bg-panel-2 px-4 py-3">
                  <div className="text-[13.5px] font-medium text-fg">{h.title}</div>
                  <div className="mt-0.5 text-[12.5px] leading-relaxed text-muted">{h.body}</div>
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>
    </div>
  )
}

function LinkRow({
  icon,
  title,
  description,
  href,
  action,
}: {
  icon: ReactNode
  title: string
  description: string
  href: string
  action: string
}) {
  return (
    <SettingsRow
      icon={icon}
      title={title}
      description={description}
      control={
        <Button
          iconRight={<ExternalLink size={13} className="text-muted" />}
          onClick={() => void invoke('app:openExternal', { url: href }).catch(() => undefined)}
        >
          {action}
        </Button>
      }
    />
  )
}

export function HelpPage() {
  const info = useAppInfo()
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(timer)
  }, [copied])

  const copyInfo = async () => {
    if (!info) return
    try {
      await invoke('clipboard:writeText', { text: formatAppInfo(info) })
      setCopied(true)
      setError(null)
    } catch (err) {
      setError(describeError(err))
    }
  }

  return (
    <div>
      <PageHeader title={t('settings.help.title')} subtitle={t('settings.help.subtitle')} />
      <div className="-mt-3">
        <LinkRow
          icon={<BookOpen size={18} />}
          title={t('settings.help.readme')}
          description={t('settings.help.readmeDescription')}
          href={DOCS_URL}
          action={t('settings.help.read')}
        />
        <LinkRow
          icon={<LifeBuoy size={18} />}
          title={t('settings.help.troubleshooting')}
          description={t('settings.help.troubleshootingDescription')}
          href={`${REPO_URL}/blob/main/docs/TROUBLESHOOTING.md`}
          action={t('settings.help.read')}
        />
        <LinkRow
          icon={<ShieldCheck size={18} />}
          title={t('settings.help.privacy')}
          description={t('settings.help.privacyDescription')}
          href={`${REPO_URL}/blob/main/PRIVACY.md`}
          action={t('settings.help.read')}
        />
        <LinkRow
          icon={<Bug size={18} />}
          title={t('settings.help.issue')}
          description={t('settings.help.issueDescription')}
          href={ISSUES_URL}
          action={t('settings.help.openIssue')}
        />
      </div>

      <Card className="mt-5">
        <div className="flex items-start gap-3.5">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] border border-line bg-panel-3 text-muted">
            <Info size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-medium text-fg">{t('settings.help.appInfo')}</div>
            <div className="mt-0.5 text-[12.5px] text-muted">
              {t('settings.help.appInfoDescription')}
            </div>
            <pre
              className="selectable mt-2.5 overflow-x-auto rounded-lg bg-panel-3 px-3 py-2 font-mono text-[12px] leading-relaxed text-fg"
              data-testid="app-info"
            >
              {info ? formatAppInfo(info) : '…'}
            </pre>
          </div>
          <Button
            size="sm"
            icon={copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
            onClick={() => void copyInfo()}
            disabled={!info}
          >
            {copied ? t('settings.help.copied') : t('settings.help.copyInfo')}
          </Button>
        </div>
        {error ? (
          <StatusLine tone="error" className="mt-2">
            {error}
          </StatusLine>
        ) : null}
      </Card>
      <p className="mt-5 text-center text-[12px] text-subtle">{t('common.notAffiliated')}</p>
    </div>
  )
}
