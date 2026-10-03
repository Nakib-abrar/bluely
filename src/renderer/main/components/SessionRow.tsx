import { ArrowUpRight, MoreHorizontal, Trash2 } from 'lucide-react'
import { t } from '@shared/i18n'
import type { SessionSummary } from '@shared/types'
import { Badge, IconButton, Menu, MenuItem, MenuSeparator } from '../../components/ui'
import { formatClock, formatDay, formatDuration } from '../../lib/format'
import { StatusChip } from './StatusChip'

export interface SessionRowProps {
  session: SessionSummary
  onOpen(): void
  onDelete(): void
}

/** One meeting in the history list: title, status, duration badge, start time, row menu. */
export function SessionRow({ session, onOpen, onDelete }: SessionRowProps) {
  const title = session.title.trim() || t('home.untitled')
  const time = formatClock(session.startedAt)
  const label = t('home.list.openMeeting', { title, day: formatDay(session.startedAt), time })
  const showDuration = session.status !== 'active' && session.durationMs != null

  return (
    <li
      className="group relative flex h-11 items-center rounded-[10px] transition-colors duration-150 hover:bg-panel focus-within:bg-panel"
      data-testid="session-row"
    >
      <button
        type="button"
        onClick={onOpen}
        aria-label={label}
        data-session-id={session.id}
        className="flex h-full min-w-0 flex-1 items-center gap-3 rounded-[10px] pr-1 pl-3.5 text-left focus-visible:-outline-offset-2"
      >
        <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-fg">{title}</span>
        <StatusChip status={session.status} />
        {showDuration ? <Badge>{formatDuration(session.durationMs)}</Badge> : null}
        <span className="tabular w-[60px] shrink-0 text-right text-[13px] text-muted">{time}</span>
      </button>
      <div className="flex w-10 shrink-0 justify-center">
        <Menu
          side="bottom"
          align="end"
          trigger={
            <IconButton
              label={t('home.list.rowActions', { title })}
              tooltip={false}
              size="sm"
              icon={<MoreHorizontal size={16} />}
              className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:bg-panel-3 data-[state=open]:opacity-100"
            />
          }
        >
          <MenuItem icon={<ArrowUpRight size={14} />} onSelect={onOpen}>
            {t('home.list.open')}
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={<Trash2 size={14} className="text-danger" />} onSelect={onDelete}>
            <span className="text-danger">{t('home.list.delete')}</span>
          </MenuItem>
        </Menu>
      </div>
    </li>
  )
}
