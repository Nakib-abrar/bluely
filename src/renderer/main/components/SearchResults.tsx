import { forwardRef, useImperativeHandle, useMemo, useRef, type ReactNode } from 'react'
import { SearchX, Sparkles } from 'lucide-react'
import { t } from '@shared/i18n'
import type { SearchGroup, SearchHit, SessionTab } from '@shared/types'
import { formatClock, formatDay } from '../../lib/format'
import type { SearchView } from '../hooks/useSearch'
import { moveResultFocus } from '../lib/focus'
import { splitSnippet } from '../lib/snippet'
import { looksLikeQuestion, tabForHit } from '../lib/text'
import { AskAcross, type AskAcrossHandle } from './AskAcross'
import { HighlightedText } from './HighlightedText'

export interface SearchResultsHandle {
  /** Enter in the search box: ask (question-like) or open the first result. */
  submit(): void
}

export interface SearchResultsProps {
  query: string
  view: SearchView
  onOpenSession(sessionId: string, tab?: SessionTab): void
  /** ↑ from the first result. */
  onFocusSearch(): void
  /** Esc inside the results. */
  onExit(): void
}

const MAX_HITS = 3

function ResultGroup({
  group,
  onOpen,
}: {
  group: SearchGroup
  onOpen(sessionId: string, tab?: SessionTab): void
}) {
  const { session } = group
  const titleHit = group.hits.find((h) => h.kind === 'title')
  const hits = group.hits.filter((h) => h.kind !== 'title')
  const shown = hits.slice(0, MAX_HITS)
  const more = hits.length - shown.length
  const title = session.title.trim() || t('home.untitled')

  return (
    <section
      className="overflow-hidden rounded-xl border border-line bg-panel"
      data-testid="search-group"
    >
      <button
        type="button"
        data-result-item=""
        onClick={() => onOpen(session.id)}
        className="flex w-full items-center gap-3 px-4 pt-3 pb-2 text-left transition-colors hover:bg-panel-2 focus-visible:-outline-offset-2"
      >
        <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-fg">
          {titleHit ? <HighlightedText parts={splitSnippet(titleHit.snippet)} /> : title}
        </span>
        <span className="tabular shrink-0 text-[12px] text-subtle">
          {formatDay(session.startedAt)} · {formatClock(session.startedAt)}
        </span>
      </button>
      {shown.length > 0 ? (
        <ul className="pb-2">
          {shown.map((hit: SearchHit, i) => (
            <li key={`${hit.kind}-${hit.refId ?? i}`}>
              <button
                type="button"
                data-result-item=""
                onClick={() => onOpen(session.id, tabForHit(hit.kind))}
                className="flex w-full items-baseline gap-3 px-4 py-1.5 text-left transition-colors hover:bg-panel-2 focus-visible:-outline-offset-2"
              >
                <span className="w-[86px] shrink-0 text-[11px] font-semibold tracking-[0.04em] text-subtle uppercase">
                  {t(`home.search.kind.${hit.kind}`)}
                </span>
                <span className="line-clamp-2 min-w-0 flex-1 text-[13px] leading-[1.5] text-muted">
                  <HighlightedText parts={splitSnippet(hit.snippet)} />
                </span>
              </button>
            </li>
          ))}
          {more > 0 ? (
            <li className="px-4 pt-0.5 pl-[118px] text-[12px] text-subtle">
              {t('home.search.moreHits', { count: more })}
            </li>
          ) : null}
        </ul>
      ) : null}
    </section>
  )
}

function ResultsSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-hidden="true">
      {[0, 1].map((i) => (
        <div key={i} className="rounded-xl border border-line bg-panel px-4 py-3.5">
          <div className="h-3.5 w-1/3 rounded bg-panel-3" />
          <div className="mt-3 h-3 w-5/6 rounded bg-panel-2" />
          <div className="mt-2 h-3 w-2/3 rounded bg-panel-2" />
        </div>
      ))}
    </div>
  )
}

/** Full-text search results with highlighted snippets and "Ask Bluely" for questions. */
export const SearchResults = forwardRef<SearchResultsHandle, SearchResultsProps>(
  function SearchResults({ query, view, onOpenSession, onFocusSearch, onExit }, ref) {
    const askRef = useRef<AskAcrossHandle>(null)
    const { result, loading, error } = view
    const q = query.trim()
    const showAsk = result && result.query === q ? result.looksLikeQuestion : looksLikeQuestion(q)
    const groups = useMemo(() => result?.groups ?? [], [result])
    const count = groups.length

    useImperativeHandle(ref, () => ({
      submit() {
        if (showAsk) {
          askRef.current?.ask()
          return
        }
        const first = groups[0]
        if (first) onOpenSession(first.session.id, tabForHit(first.hits[0]?.kind ?? 'title'))
      },
    }))

    let body: ReactNode = null
    if (error && !result) {
      body = (
        <div className="py-12 text-center" role="alert">
          <div className="text-[14px] font-medium text-fg">{t('home.search.failed')}</div>
          <div className="mt-1 text-[12.5px] text-subtle">{error}</div>
        </div>
      )
    } else if (!result) {
      body = loading ? <ResultsSkeleton /> : null
    } else if (count === 0) {
      body = loading ? (
        <ResultsSkeleton />
      ) : (
        <div className="flex flex-col items-center py-14 text-center" data-testid="search-empty">
          <SearchX size={26} className="mb-3 text-subtle" />
          <div className="text-[14.5px] font-semibold text-fg">
            {t('home.search.noResults', { query: q })}
          </div>
          <div className="mt-1 max-w-[440px] text-[13px] text-muted">
            {t('home.search.noResultsBody')}
          </div>
        </div>
      )
    } else {
      body = (
        <>
          <div className="mb-3 flex items-center gap-3 text-[12.5px] text-subtle">
            <span className="font-medium">
              {count === 1 ? t('home.search.resultsOne') : t('home.search.resultsCount', { count })}
            </span>
            {result.fuzzy ? (
              <span
                className="inline-flex items-center gap-1.5 text-muted"
                data-testid="fuzzy-note"
              >
                <Sparkles size={12} className="text-accent-text" />
                {t('home.search.fuzzy')}
              </span>
            ) : null}
          </div>
          <div className="flex flex-col gap-3">
            {groups.map((g) => (
              <ResultGroup key={g.session.id} group={g} onOpen={onOpenSession} />
            ))}
          </div>
        </>
      )
    }

    return (
      <div
        className="h-full overflow-y-auto"
        data-testid="search-results"
        onKeyDown={(e) => {
          const target = e.target as HTMLElement
          if (!target.hasAttribute('data-result-item')) return
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            moveResultFocus(target, 1)
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            if (!moveResultFocus(target, -1)) onFocusSearch()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onExit()
          }
        }}
      >
        <div
          className="mx-auto max-w-[920px] px-10 pt-8 pb-16 transition-opacity duration-150"
          style={{ opacity: loading && result ? 0.65 : 1 }}
        >
          {showAsk && q ? (
            <div className="mb-6">
              <AskAcross ref={askRef} question={q} />
            </div>
          ) : null}
          {body}
        </div>
      </div>
    )
  },
)
