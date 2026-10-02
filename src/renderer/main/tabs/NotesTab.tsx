import { CheckCircle2, FileText, Sparkles } from 'lucide-react'
import { t } from '@shared/i18n'
import type { SessionDetail } from '@shared/types'
import { Button, CopyButton } from '../../components/ui'
import { notesToMarkdown } from '../lib/copyText'
import { SectionLabel, TabEmpty, TabGenerating } from './TabState'

export interface NotesTabProps {
  detail: SessionDetail
  title: string
  onRegenerate(): void
}

/** Summary paragraph, key points and decisions written after the call. */
export function NotesTab({ detail, title, onRegenerate }: NotesTabProps) {
  const notes = detail.notes
  if (!notes) {
    if (detail.status === 'processing')
      return <TabGenerating label={t('session.notes.generating')} />
    // Recovered/failed meetings get this action from the status banner instead.
    const canGenerate = detail.transcript.length > 0 && detail.status === 'done'
    return (
      <TabEmpty
        icon={<FileText size={20} />}
        title={t('session.notes.empty')}
        body={t('session.notes.emptyBody')}
        action={
          canGenerate ? (
            <Button
              size="sm"
              variant="secondary"
              icon={<Sparkles size={13} />}
              onClick={onRegenerate}
            >
              {t('session.banner.generate')}
            </Button>
          ) : undefined
        }
      />
    )
  }

  return (
    <div className="selectable space-y-8" data-testid="notes-tab">
      {notes.summary.trim() ? (
        <section>
          <SectionLabel
            right={
              <CopyButton text={notesToMarkdown(title, notes)} label={t('session.notes.copy')} />
            }
          >
            {t('session.notes.summary')}
          </SectionLabel>
          <p className="text-[14.5px] leading-[1.65] text-fg">{notes.summary}</p>
        </section>
      ) : null}

      {notes.keyPoints.length > 0 ? (
        <section>
          <SectionLabel>{t('session.notes.keyPoints')}</SectionLabel>
          <ul className="space-y-2">
            {notes.keyPoints.map((p, i) => (
              <li key={i} className="flex gap-3 text-[14px] leading-[1.6] text-fg">
                <span
                  aria-hidden="true"
                  className="mt-[9px] h-1.5 w-1.5 shrink-0 rounded-full bg-accent-2"
                />
                <span className="min-w-0">{p}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <SectionLabel>{t('session.notes.decisions')}</SectionLabel>
        {notes.decisions.length > 0 ? (
          <ul className="space-y-2">
            {notes.decisions.map((d, i) => (
              <li key={i} className="flex gap-2.5 text-[14px] leading-[1.6] text-fg">
                <CheckCircle2 size={16} className="mt-[3px] shrink-0 text-success" />
                <span className="min-w-0">{d}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[13.5px] text-subtle">{t('session.notes.noDecisions')}</p>
        )}
      </section>
    </div>
  )
}
