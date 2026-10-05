import { create } from 'zustand'

/** Per-channel selection is captured on send, including optimistic retries. */
export const useTaskSelection = create<{ references: Record<string, string>; select(channelId: string, reference: string): void }>((set) => ({
  references: {}, select: (channelId, reference) => set((state) => ({ references: { ...state.references, [channelId]: reference } })),
}))
