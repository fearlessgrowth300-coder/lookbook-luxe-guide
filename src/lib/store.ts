import { create } from "zustand";

export type Mood = "sharp" | "easy" | "playful";

interface UIState {
  mood: Mood;
  setMood: (m: Mood) => void;
  selectedItemIds: Set<string>;
  toggleSelect: (id: string) => void;
  clearSelection: () => void;
  uploadOpen: boolean;
  setUploadOpen: (v: boolean) => void;
}

export const useUI = create<UIState>((set) => ({
  mood: "sharp",
  setMood: (m) => set({ mood: m }),
  selectedItemIds: new Set(),
  toggleSelect: (id) =>
    set((s) => {
      const next = new Set(s.selectedItemIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { selectedItemIds: next };
    }),
  clearSelection: () => set({ selectedItemIds: new Set() }),
  uploadOpen: false,
  setUploadOpen: (v) => set({ uploadOpen: v }),
}));
