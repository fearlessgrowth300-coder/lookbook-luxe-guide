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

// ─── Three-Looks bottom sheet ────────────────────────────────────────────────
// Global state so that any component (Today, recent-look cards, deep-link
// handlers, future PWA notifications) can open the modal without prop drilling.
interface ThreeLooksSheetState {
  isOpen: boolean;
  batchId: string | null;
  open: (batchId: string) => void;
  close: () => void;
  setBatchId: (batchId: string) => void;
}

export const useThreeLooksSheet = create<ThreeLooksSheetState>((set) => ({
  isOpen: false,
  batchId: null,
  open: (batchId) => set({ isOpen: true, batchId }),
  close: () => set({ isOpen: false }),
  setBatchId: (batchId) => set({ batchId }),
}));

// ─── Styler session (in-memory only) ─────────────────────────────────────────
// Tracks the last few batch_ids the user generated in this session, so the
// server can avoid handing back items from those batches on the next generate.
interface StylerSessionState {
  recentBatchIds: string[];
  pushBatch: (id: string) => void;
  clear: () => void;
}

export const useStylerSession = create<StylerSessionState>((set) => ({
  recentBatchIds: [],
  pushBatch: (id) =>
    set((s) => ({
      recentBatchIds: [id, ...s.recentBatchIds.filter((x) => x !== id)].slice(0, 3),
    })),
  clear: () => set({ recentBatchIds: [] }),
}));


