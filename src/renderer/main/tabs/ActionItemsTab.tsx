import type { ReactNode } from 'react'
import { CalendarDays, ListChecks, UserRound } from 'lucide-react'
import { t } from '@shared/i18n'
import type { ActionItem, SessionDetail } from '@shared/types'
import { cn } from '../../components/ui'
import { errorMessage, invoke } from '../../lib/ipc'
import { Checkbox } from '../components/Checkbox'
import { toast } from '../stores/toast'
import { TabEmpty, TabGenerating } from './TabState'

export interface ActionItemsTabProps {
  detail: SessionDetail
  patch(fn: (d: SessionDetail) => SessionDetail): void
}

function setItem(d: SessionDetail, item: ActionItem): SessionDetail {
  return { ...d, actionItems: d.actionItems.map((a) => (a.id === item.id ? item : a)) }
}

function Chip({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <span
      className="inline-flex h-[22px] items-center gap-1.5 rounded-md border border-line bg-panel-2 px-2 text-[12px] text-muted"
      title={`${label}: ${value}`}
    >
      <span className="text-subtle">{icon}</span>
      {value}
    </span>
  )
}

/** Checkbox list of action items; done state is saved optimistically. */
export function ActionItemsTab({ detail, patch }: ActionItemsTabProps) {
  const items = detail.actionItems
  if (items.length === 0) {
    if (detail.status === 'processing')
      return <TabGenerating label={t('session.actions.generating')} />
    return (
      <TabEmpty
        icon={<ListChecks size={20} />}
        title={t('session.actions.empty')}
        body={t('session.actions.emptyBody')}
      />
    )
  }

  const done = items.filter((a) => a.done).length

  const toggle = (item: ActionItem, next: boolean) => {
    patch((d) => setItem(d, { ...item, done: next }))
    invoke('actionItems:setDone', { id: item.id, done: next })
      .then((saved) => patch((d) => setItem(d, saved)))
      .catch((err: unknown) => {
        patch((d) => setItem(d, item))
        toast(`${t('session.actions.toggleFailed')}: ${errorMessage(err)}`, 'error')
      })
  }

  return (
    <div data-testid="actions-tab">
      <div className="mb-3 text-[12.5px] text-subtle">
        {t('session.actions.summary', { open: items.length - done, done })}
      </div>
      <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-panel">
        {items.map((item) => {
          const id = `ai-${item.id}`
          return (
            <li
              key={item.id}
              className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-panel-2"
            >
              <span className="pt-[2px]">
                <Checkbox id={id} checked={item.done} onCheckedChange={(v) => toggle(item, v)} />
              </span>
              <div className="min-w-0 flex-1">
                <label
                  htmlFor={id}
                  className={cn(
                    'selectable block text-[14px] leading-[1.55] transition-colors duration-150',
                    item.done ? 'text-subtle line-through decoration-subtle/60' : 'text-fg',
                  )}
                >
                  {item.text}
                </label>
                {item.owner || item.due ? (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {item.owner ? (
                      <Chip
                        icon={<UserRound size={11} />}
                        label={t('session.actions.owner')}
                        value={item.owner}
                      />
                    ) : null}
                    {item.due ? (
                      <Chip
                        icon={<CalendarDays size={11} />}
                        label={t('session.actions.due')}
                        value={item.due}
                      />
                    ) : null}
                  </div>
                ) : null}
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
