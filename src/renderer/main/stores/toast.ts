import { create } from 'zustand'

export type ToastTone = 'neutral' | 'success' | 'error'

export interface Toast {
  id: number
  message: string
  tone: ToastTone
}

interface ToastState {
  toasts: Toast[]
  show(message: string, tone?: ToastTone): void
  dismiss(id: number): void
}

let nextId = 1
const TOAST_MS = 3800

/** Small transient confirmations ("Saved to …", "Copied") for the main window. */
export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  show(message, tone = 'neutral') {
    const id = nextId++
    set({ toasts: [...get().toasts.slice(-2), { id, message, tone }] })
    setTimeout(() => get().dismiss(id), TOAST_MS)
  },
  dismiss(id) {
    set({ toasts: get().toasts.filter((x) => x.id !== id) })
  },
}))

/** Shorthand usable outside React components. */
export function toast(message: string, tone?: ToastTone): void {
  useToasts.getState().show(message, tone)
}
