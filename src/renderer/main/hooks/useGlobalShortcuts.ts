import { useEffect } from 'react'

/**
 * Window-level shortcuts while the main window is focused: Ctrl+K / Ctrl+F focus search,
 * Alt+← and the mouse "back" button go back.
 */
export function useGlobalShortcuts(opts: { focusSearch(): void; back(): void }): void {
  const { focusSearch, back } = opts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (mod && !e.shiftKey && !e.altKey && (e.key === 'k' || e.key === 'f')) {
        e.preventDefault()
        focusSearch()
      } else if (e.altKey && !mod && e.key === 'ArrowLeft') {
        e.preventDefault()
        back()
      }
    }
    const onMouse = (e: MouseEvent) => {
      if (e.button === 3) back()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mouseup', onMouse)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mouseup', onMouse)
    }
  }, [focusSearch, back])
}
