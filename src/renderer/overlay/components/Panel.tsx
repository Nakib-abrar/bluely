import { X } from 'lucide-react'
import { t } from '@shared/i18n'
import { cn, IconButton, TabList, TabsContent, TabsRoot } from '../../components/ui'
import { selectTab, setExpanded } from '../actions'
import { useUi, type OverlayTab } from '../stores/uiStore'
import { ActionRow } from './ActionRow'
import { AskInput } from './AskInput'
import { CardList } from './CardList'
import { DevPanel } from './DevPanel'
import { ModeChip } from './ModeChip'
import { NoticeRow } from './NoticeRow'
import { TranscriptView } from './TranscriptView'
import { Warnings } from './Warnings'

function UnseenBadge() {
  const unseen = useUi((s) => s.unseen)
  if (!unseen) return null
  return (
    <span
      className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] leading-none font-semibold text-white"
      aria-label={t('overlay.panel.newAnswers', { count: unseen })}
    >
      {unseen}
    </span>
  )
}

/**
 * The expanded panel below the pill: header (collapse, tabs, mode), dev latency table,
 * warnings, the Insights / Transcript lists, then the action row and the ask input.
 */
export function Panel({
  height,
  closing,
  onExited,
}: {
  height: number
  closing: boolean
  onExited: () => void
}) {
  const tab = useUi((s) => s.tab)
  const devOpen = useUi((s) => s.devOpen)

  return (
    <section
      data-hit
      aria-label={t('overlay.panel.label')}
      style={{ height }}
      onAnimationEnd={(e) => {
        if (closing && e.target === e.currentTarget) onExited()
      }}
      className={cn(
        'relative mt-2 flex w-full flex-col overflow-hidden rounded-2xl border border-ov-line bg-ov-panel shadow-panel',
        closing ? 'ov-panel-out pointer-events-none' : 'ov-panel-in',
      )}
    >
      <TabsRoot
        value={tab}
        onValueChange={(v) => selectTab(v as OverlayTab)}
        // overflow-hidden: nothing in the upper part may ever paint over the input below.
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
      >
        <header className="flex shrink-0 items-center gap-2 px-3 pt-3 pb-1.5">
          <IconButton
            size="sm"
            shape="round"
            label={t('overlay.panel.close')}
            icon={<X size={15} />}
            onClick={() => void setExpanded(false)}
            className="bg-panel-3/70 text-fg hover:bg-panel-4"
          />
          <TabList<OverlayTab>
            variant="pill"
            className="rounded-full! bg-panel-3/60! p-0.5! [&>button]:h-7 [&>button]:rounded-full [&>button]:px-3 [&>button]:text-[12.5px]"
            items={[
              { value: 'insights', label: t('overlay.panel.insights'), badge: <UnseenBadge /> },
              { value: 'transcript', label: t('overlay.panel.transcript') },
            ]}
          />
          <div className="flex-1" />
          <ModeChip />
        </header>

        {devOpen ? <DevPanel /> : null}
        <Warnings />

        <TabsContent
          value="insights"
          forceMount
          className="relative min-h-0 flex-1 data-[state=inactive]:hidden"
        >
          <CardList />
        </TabsContent>
        <TabsContent
          value="transcript"
          forceMount
          className="relative min-h-0 flex-1 data-[state=inactive]:hidden"
        >
          <TranscriptView />
        </TabsContent>
      </TabsRoot>

      <footer className="shrink-0 px-3 pt-1 pb-3">
        <NoticeRow />
        <ActionRow />
        <AskInput />
      </footer>
    </section>
  )
}
