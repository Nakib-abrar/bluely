import { Header } from './Header'
import { SessionList } from './SessionList'

/** Home: header (wordmark, mode, Start) above the day-grouped meeting history. */
export function HomePage() {
  return (
    <div
      className="h-full overflow-y-auto outline-none"
      data-testid="home-page"
      tabIndex={-1}
      data-home-focus=""
    >
      <Header />
      <div className="mx-auto max-w-[920px] px-10 pt-7 pb-16">
        <SessionList />
      </div>
    </div>
  )
}
