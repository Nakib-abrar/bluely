import { create } from 'zustand'

interface RefreshState {
  /** Incremented by the header refresh button; data hooks re-fetch when it changes. */
  nonce: number
  bump(): void
}

export const useRefresh = create<RefreshState>((set, get) => ({
  nonce: 0,
  bump: () => set({ nonce: get().nonce + 1 }),
}))
