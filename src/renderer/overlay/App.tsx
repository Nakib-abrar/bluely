import { ChevronDown, Square } from 'lucide-react'
import { LogoMark } from '../components/ui'

/** Foundation shell for the overlay pill. The full overlay UI is built on top. */
export function App() {
  return (
    <div className="flex justify-center pt-2">
      <div className="drag flex h-11 items-center gap-1.5 rounded-full border border-ov-line bg-ov-pill px-1.5 shadow-panel">
        <button
          type="button"
          aria-label="Bluely"
          className="no-drag flex h-8 w-8 items-center justify-center rounded-full"
        >
          <LogoMark size={22} />
        </button>
        <button
          type="button"
          className="no-drag flex h-8 items-center gap-1 rounded-full bg-panel-3 px-3 text-[13px] font-medium"
        >
          <ChevronDown size={14} /> Hide
        </button>
        <button
          type="button"
          aria-label="Stop"
          className="no-drag flex h-8 w-8 items-center justify-center rounded-full bg-panel-3"
        >
          <Square size={12} fill="currentColor" />
        </button>
      </div>
    </div>
  )
}
