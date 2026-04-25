import { createFileRoute } from "@tanstack/react-router";
import { motion, AnimatePresence } from "framer-motion";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, X, Upload as UploadIcon, Camera, ImageIcon, Check, Sparkles, Layers, Shirt } from "lucide-react";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import { Shell } from "@/components/Shell";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { SetWizard } from "@/components/SetWizard";
import { useAuth } from "@/lib/auth";
import { useUI } from "@/lib/store";
import { supabase } from "@/integrations/supabase/client";
import { ease, dur, tap } from "@/lib/motion";
import { prepareUploadAssets } from "@/lib/thumbnail";
import { readFileToBlob, blobToFile } from "@/lib/safe-file-read";
import { DbInsertError, getStep, UploadError } from "@/lib/upload-errors";
import { type Category } from "@/server/mock-ai";
import { removeBg, warmBgRemoval } from "@/lib/bg-removal";
import { analyzeWardrobeItem } from "@/server/functions/analyzeItem";

export const Route = createFileRoute("/wardrobe")({
  component: () => (
    <ProtectedRoute>
      <WardrobePage />
    </ProtectedRoute>
  ),
  head: () => ({ meta: [{ title: "Wardrobe — Atelier" }] }),
});

const FILTERS: { id: Category | "all" | "sets"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "sets", label: "Sets" },
  { id: "top", label: "Tops" },
  { id: "bottom", label: "Bottoms" },
  { id: "outerwear", label: "Outerwear" },
  { id: "shoes", label: "Shoes" },
  { id: "accessory", label: "Accessories" },
];

const CATEGORY_OPTIONS: { id: Category; label: string }[] = [
  { id: "top", label: "Top" },
  { id: "bottom", label: "Bottom" },
  { id: "outerwear", label: "Outerwear" },
  { id: "dress", label: "Dress" },
  { id: "shoes", label: "Shoes" },
  { id: "accessory", label: "Accessory" },
  { id: "bag", label: "Bag" },
];

const FORMALITY_OPTIONS: { label: string; score: number }[] = [
  { label: "Casual", score: 3 },
  { label: "Smart", score: 6 },
  { label: "Formal", score: 9 },
];

/** Snap any 1-10 AI score to the nearest Casual / Smart / Formal bucket. */
function snapFormality(score: number | null | undefined): number {
  if (typeof score !== "number" || !Number.isFinite(score)) return 6;
  if (score <= 4) return 3;
  if (score <= 7) return 6;
  return 9;
}

// Subcategories that came from the mock AI archetypes.
// If any item carries one of these, we surface the "Fix my wardrobe" banner.
const MOCK_SUBCATEGORIES = new Set([
  "oxford shirt",
  "wool trousers",
  "wool coat",
  "leather loafer",
  "silk scarf",
  "midi dress",
]);

interface WardrobeItem {
  id: string;
  raw_path: string;
  enhanced_path: string | null;
  thumbnail_path: string | null;
  placeholder: string | null;
  category: Category | null;
  subcategory: string | null;
  color_primary: string | null;
  formality_score: number | null;
  set_id: string | null;
  set_role: string | null;
}

interface GarmentSet {
  id: string;
  name: string | null;
  set_type: string | null;
  formality_score: number | null;
  occasion_tags: string[] | null;
  separable_pieces: string[] | null;
  cultural_context: string | null;
}

type PendingUploadStage = "decoding" | "preparing" | "uploading" | "enhancing";

interface PendingUploadItem {
  id: string;
  previewUrl: string;
  stage: PendingUploadStage;
}

const PENDING_STAGE_LABELS: Record<PendingUploadStage, string> = {
  decoding: "DECODING",
  preparing: "PREPARING",
  uploading: "UPLOADING",
  enhancing: "ENHANCING",
};

function WardrobePage() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const { uploadOpen, setUploadOpen, selectedItemIds, toggleSelect, clearSelection } = useUI();
  const [filter, setFilter] = useState<Category | "all" | "sets">("all");
  const [pendingUpload, setPendingUpload] = useState<PendingUploadItem | null>(null);
  const [editItemId, setEditItemId] = useState<string | null>(null);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  // When uploadOpen is true we first show an entry-choice sheet asking the
  // user whether they're adding a single piece or a coordinated set.
  const [entryChoice, setEntryChoice] = useState<"single" | "set" | null>(null);

  const itemsQuery = useQuery({
    queryKey: ["wardrobe", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wardrobe_items")
        .select(
          "id, raw_path, enhanced_path, thumbnail_path, placeholder, category, subcategory, color_primary, formality_score, set_id, set_role",
        )
        .eq("user_id", user!.id)
        .eq("archived", false)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as WardrobeItem[];
    },
  });

  const setsQuery = useQuery({
    queryKey: ["garment-sets", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("garment_sets" as any)
        .select(
          "id, name, set_type, formality_score, occasion_tags, separable_pieces, cultural_context",
        )
        .eq("user_id", user!.id)
        .eq("archived", false)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as GarmentSet[];
    },
  });

  // Realtime: when enhance-item completes, swap shimmer → enhanced image
  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel("wardrobe-updates")
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "wardrobe_items",
          filter: `user_id=eq.${user.id}`,
        },
        () => {
          qc.invalidateQueries({ queryKey: ["wardrobe", user.id] });
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [user, qc]);

  const items = itemsQuery.data ?? [];
  const sets = setsQuery.data ?? [];

  // Group items by set membership, distinguishing locked vs separable pieces.
  // A locked piece does NOT show under category filters (Tops, Bottoms…) —
  // it lives only inside its parent set tile.
  const setsById = useMemo(() => {
    const m = new Map<string, GarmentSet>();
    sets.forEach((s) => m.set(s.id, s));
    return m;
  }, [sets]);

  const setMembers = useMemo(() => {
    const m = new Map<string, WardrobeItem[]>();
    items.forEach((it) => {
      if (!it.set_id) return;
      const list = m.get(it.set_id) ?? [];
      list.push(it);
      m.set(it.set_id, list);
    });
    return m;
  }, [items]);

  const isPieceSeparable = (item: WardrobeItem): boolean => {
    if (!item.set_id) return true;
    const parent = setsById.get(item.set_id);
    if (!parent) return true;
    if (!item.set_role) return false;
    return (parent.separable_pieces ?? []).includes(item.set_role);
  };

  /** Standalone items + items from sets that are marked separable. */
  const standaloneEligible = useMemo(
    () => items.filter((i) => !i.set_id || isPieceSeparable(i)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, setsById],
  );

  // Build the filtered display list. For "all" we show standalone items + one
  // compound tile per set. For "sets" we show only set tiles. For category
  // chips we show items eligible at standalone level only.
  type DisplayEntry =
    | { kind: "item"; item: WardrobeItem }
    | { kind: "set"; set: GarmentSet; pieces: WardrobeItem[] };

  const filtered: DisplayEntry[] = useMemo(() => {
    if (filter === "sets") {
      return sets.map((s) => ({
        kind: "set" as const,
        set: s,
        pieces: setMembers.get(s.id) ?? [],
      }));
    }
    if (filter === "all") {
      const standalonePart: DisplayEntry[] = items
        .filter((i) => !i.set_id)
        .map((item) => ({ kind: "item" as const, item }));
      const setPart: DisplayEntry[] = sets.map((s) => ({
        kind: "set" as const,
        set: s,
        pieces: setMembers.get(s.id) ?? [],
      }));
      return [...setPart, ...standalonePart];
    }
    // Category filters: only show separable / standalone pieces
    return standaloneEligible
      .filter((i) => i.category === filter)
      .map((item) => ({ kind: "item" as const, item }));
  }, [filter, items, sets, setMembers, standaloneEligible]);

  const visibleItems = useMemo(
    () =>
      pendingUpload
        ? filtered.filter((entry) => !(entry.kind === "item" && entry.item.id === pendingUpload.id))
        : filtered,
    [filtered, pendingUpload],
  );

  useEffect(() => {
    if (!pendingUpload) return;
    const matchingItem = items.find((item) => item.id === pendingUpload.id);
    if (!matchingItem) return;

    if (matchingItem.enhanced_path) {
      URL.revokeObjectURL(pendingUpload.previewUrl);
      setPendingUpload(null);
      return;
    }

    if (pendingUpload.stage !== "enhancing") {
      setPendingUpload({ ...pendingUpload, stage: "enhancing" });
    }
  }, [items, pendingUpload]);

  const categoryCount = new Set(items.map((i) => i.category).filter(Boolean)).size;

  const miscategorized = useMemo(
    () => items.filter((i) => i.subcategory && MOCK_SUBCATEGORIES.has(i.subcategory.toLowerCase())),
    [items],
  );
  const showBanner = !bannerDismissed && miscategorized.length > 0;

  const archiveMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      const { error } = await supabase
        .from("wardrobe_items")
        .update({ archived: true })
        .in("id", ids);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wardrobe", user?.id] });
      clearSelection();
      toast("Archived");
    },
  });

  return (
    <Shell>
      {/* Sticky header */}
      <header className="sticky top-16 z-30 border-b border-linen bg-bone/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1280px] flex-col gap-6 px-6 py-6">
          <div className="flex items-end justify-between gap-6">
            <div>
              <h1 className="font-display text-[28px] font-light leading-none text-graphite">
                Wardrobe
              </h1>
              <p className="mt-2 font-mono text-[11px] uppercase tracking-[0.2em] text-ink">
                {items.length} ITEMS · {categoryCount} CATEGORIES
              </p>
            </div>
            <motion.button
              {...tap}
              onClick={() => setUploadOpen(true)}
              className="flex h-10 w-10 items-center justify-center rounded-full border border-ink text-graphite transition-colors hover:border-graphite hover:bg-graphite hover:text-bone"
              aria-label="Add item"
            >
              <Plus className="h-4 w-4" strokeWidth={1.5} />
            </motion.button>
          </div>

          <div className="flex flex-wrap gap-2 overflow-x-auto">
            {FILTERS.map(({ id, label }) => {
              const active = filter === id;
              return (
                <motion.button
                  {...tap}
                  key={id}
                  onClick={() => setFilter(id)}
                  className={`h-8 shrink-0 rounded-full px-4 font-mono text-[11px] uppercase tracking-[0.16em] transition-colors ${
                    active
                      ? "bg-graphite text-bone"
                      : "border border-ink text-ink hover:border-graphite hover:text-graphite"
                  }`}
                >
                  {label}
                </motion.button>
              );
            })}
          </div>
        </div>
      </header>

      {/* Fix-my-wardrobe banner (only when mock-AI subcategories detected) */}
      <AnimatePresence>
        {showBanner && (
          <motion.button
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: dur.page, ease: ease.luxury }}
            onClick={() => setEditItemId(miscategorized[0].id)}
            className="block w-full border-b border-linen bg-linen/60 hover:bg-linen"
          >
            <div className="mx-auto flex max-w-[1280px] items-center justify-between gap-4 px-6 py-3">
              <div className="flex items-center gap-3 text-left">
                <Sparkles className="h-4 w-4 shrink-0 text-graphite" strokeWidth={1.25} />
                <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-graphite">
                  Some items were auto-categorized. Tap to review.
                </p>
              </div>
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  setBannerDismissed(true);
                }}
                className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink hover:text-graphite"
              >
                Dismiss
              </span>
            </div>
          </motion.button>
        )}
      </AnimatePresence>

      {/* Grid */}
      <section className="mx-auto max-w-[1280px] px-6 py-12">
        {itemsQuery.isLoading ? (
          <Grid>
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="aspect-[3/4] atelier-shimmer" />
            ))}
          </Grid>
        ) : visibleItems.length === 0 && !pendingUpload ? (
          <EmptyState onAdd={() => setUploadOpen(true)} hasItems={items.length > 0} />
        ) : (
          <AnimatePresence mode="wait">
            <motion.div
              key={filter}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18, ease: ease.tactile }}
            >
              <Grid>
                {pendingUpload && (
                  <Tile
                    key={`pending-${pendingUpload.id}`}
                    index={0}
                    pending={{ previewUrl: pendingUpload.previewUrl, label: PENDING_STAGE_LABELS[pendingUpload.stage] }}
                  />
                )}
                {visibleItems.map((entry, i) => {
                  const idx = pendingUpload ? i + 1 : i;
                  if (entry.kind === "set") {
                    return (
                      <SetTile
                        key={`set-${entry.set.id}`}
                        set={entry.set}
                        pieces={entry.pieces}
                        index={idx}
                      />
                    );
                  }
                  const item = entry.item;
                  return (
                    <Tile
                      key={item.id}
                      item={item}
                      index={idx}
                      selected={selectedItemIds.has(item.id)}
                      onToggleSelect={() => toggleSelect(item.id)}
                      onTap={() => {
                        if (selectedItemIds.size > 0) toggleSelect(item.id);
                        else setEditItemId(item.id);
                      }}
                    />
                  );
                })}
              </Grid>
            </motion.div>
          </AnimatePresence>
        )}
      </section>

      {/* Selection action bar */}
      <AnimatePresence>
        {selectedItemIds.size > 0 && (
          <motion.div
            initial={{ y: 100 }}
            animate={{ y: 0 }}
            exit={{ y: 100 }}
            transition={{ duration: dur.page, ease: ease.luxury }}
            className="fixed bottom-16 left-0 right-0 z-40 border-t border-linen bg-bone p-4"
          >
            <div className="mx-auto flex max-w-[1280px] items-center justify-between px-6">
              <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink">
                {selectedItemIds.size} selected
              </p>
              <div className="flex gap-3">
                <button
                  onClick={clearSelection}
                  className="font-mono text-[11px] uppercase tracking-[0.16em] text-ink hover:text-graphite"
                >
                  Cancel
                </button>
                <motion.button
                  {...tap}
                  onClick={() => archiveMutation.mutate(Array.from(selectedItemIds))}
                  className="h-10 bg-graphite px-5 font-mono text-[11px] uppercase tracking-[0.16em] text-bone hover:bg-noir"
                >
                  Archive
                </motion.button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Entry choice: single piece vs part of a set */}
      <AnimatePresence>
        {uploadOpen && entryChoice === null && (
          <EntryChoiceSheet
            onPickSingle={() => setEntryChoice("single")}
            onPickSet={() => setEntryChoice("set")}
            onClose={() => setUploadOpen(false)}
          />
        )}
      </AnimatePresence>

      {/* Upload sheet — single piece flow */}
      <AnimatePresence>
        {uploadOpen && entryChoice === "single" && (
          <UploadSheet
            onClose={() => {
              setUploadOpen(false);
              setEntryChoice(null);
            }}
            onPendingChange={setPendingUpload}
          />
        )}
      </AnimatePresence>

      {/* Set wizard — multi-piece coordinated flow */}
      <AnimatePresence>
        {uploadOpen && entryChoice === "set" && (
          <SetWizard
            onClose={() => {
              setUploadOpen(false);
              setEntryChoice(null);
            }}
          />
        )}
      </AnimatePresence>

      {/* Edit sheet */}
      <AnimatePresence>
        {editItemId && (
          <EditSheet
            item={items.find((i) => i.id === editItemId) ?? null}
            onClose={() => setEditItemId(null)}
            onAdvance={() => {
              const remaining = miscategorized.filter((m) => m.id !== editItemId);
              if (remaining.length > 0) setEditItemId(remaining[0].id);
              else setEditItemId(null);
            }}
            hasMore={miscategorized.filter((m) => m.id !== editItemId).length > 0}
          />
        )}
      </AnimatePresence>
    </Shell>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="grid gap-4"
      style={{
        gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
      }}
    >
      {children}
    </div>
  );
}

function Tile({
  item,
  index,
  selected,
  onToggleSelect,
  onTap,
  pending,
}: {
  item?: WardrobeItem;
  index: number;
  selected?: boolean;
  onToggleSelect?: () => void;
  onTap?: () => void;
  pending?: { previewUrl: string; label: string };
}) {
  const stagger = Math.min(index, 17) * 0.035;
  const thumbUrl = item?.thumbnail_path
    ? supabase.storage.from("wardrobe-thumbs").getPublicUrl(item.thumbnail_path).data.publicUrl
    : null;
  const enhancedUrl = item?.enhanced_path
    ? supabase.storage.from("wardrobe-enhanced").getPublicUrl(item.enhanced_path).data.publicUrl
    : null;
  // Prefer the enhanced (background-removed) PNG so wardrobe tiles always
  // show the cutout look. Thumbnails are generated from the raw upload and
  // still contain the original background, so they're only used as a fallback
  // before enhancement completes.
  const initialUrl = pending?.previewUrl ?? enhancedUrl ?? thumbUrl;
  const [imgUrl, setImgUrl] = useState<string | null>(initialUrl);
  const [broken, setBroken] = useState(false);

  const longPressTimer = useRef<number | null>(null);
  const longPressFiredRef = useRef(false);

  useEffect(() => {
    setImgUrl(pending?.previewUrl ?? enhancedUrl ?? thumbUrl);
    setBroken(false);
  }, [enhancedUrl, pending?.previewUrl, thumbUrl]);

  // One-shot diagnostic — log only when an image fails or is missing a path.
  useEffect(() => {
    if (!item || pending) return;
    if (!thumbUrl && !enhancedUrl) {
      // eslint-disable-next-line no-console
      console.warn("[wardrobe-tile] no image paths", {
        id: item.id,
        thumbnail_path: item.thumbnail_path,
        enhanced_path: item.enhanced_path,
      });
    }
  }, [item, pending, thumbUrl, enhancedUrl]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: stagger, duration: dur.page, ease: ease.luxury }}
      whileHover={{ scale: 1.02, rotate: 2 }}
      onContextMenu={(e) => {
        e.preventDefault();
        onToggleSelect?.();
      }}
      onPointerDown={() => {
        longPressFiredRef.current = false;
        if (onToggleSelect) {
          longPressTimer.current = window.setTimeout(() => {
            longPressFiredRef.current = true;
            onToggleSelect();
          }, 500);
        }
      }}
      onPointerUp={() => {
        if (longPressTimer.current) clearTimeout(longPressTimer.current);
      }}
      onPointerLeave={() => {
        if (longPressTimer.current) clearTimeout(longPressTimer.current);
      }}
      onClick={() => {
        if (longPressFiredRef.current) {
          longPressFiredRef.current = false;
          return;
        }
        onTap?.();
      }}
      className={`group relative aspect-[3/4] cursor-pointer bg-linen p-3 transition-shadow ${
        selected ? "ring-1 ring-graphite ring-offset-2 ring-offset-bone" : ""
      }`}
      style={{ transitionDuration: "320ms", transitionTimingFunction: "cubic-bezier(0.16,1,0.3,1)" }}
    >
      {!imgUrl || pending ? (
        <div className="absolute inset-3 atelier-shimmer" />
      ) : item ? (
        broken ? (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-ink/40">
            <ImageIcon className="h-6 w-6" strokeWidth={1.25} />
            <span className="font-mono text-[10px] uppercase tracking-[0.16em]">
              {item.category || "item"}
            </span>
          </div>
        ) : (
          <motion.img
            src={imgUrl}
            alt={item.subcategory || "Wardrobe item"}
            loading="lazy"
            decoding="async"
            onError={() => {
              // Try enhanced as a fallback if thumbnail failed
              if (imgUrl === thumbUrl && enhancedUrl) {
                // eslint-disable-next-line no-console
                console.warn("[wardrobe-tile] thumb failed, falling back to enhanced", {
                  id: item.id,
                  thumb: thumbUrl,
                });
                setImgUrl(enhancedUrl);
                return;
              }
              // eslint-disable-next-line no-console
              console.error("[wardrobe-tile] image failed to load", {
                id: item.id,
                url: imgUrl,
              });
              setBroken(true);
            }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.42, ease: ease.luxury }}
            className="h-full w-full object-contain"
          />
        )
      ) : null}

      {pending && imgUrl && (
        <img src={imgUrl} alt="Uploading wardrobe item" className="h-full w-full object-contain opacity-40" />
      )}

      {pending && (
        <div className="absolute inset-x-3 bottom-3 flex items-center justify-between border border-ink/20 bg-bone/90 px-3 py-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-graphite">
            {pending.label}
          </span>
          <span className="h-2 w-2 rounded-full bg-graphite" />
        </div>
      )}

      {/* Meta bar */}
      <div
        className="absolute inset-x-0 bottom-0 translate-y-full bg-bone/95 px-3 py-2 transition-transform group-hover:translate-y-0"
        style={{ transitionDuration: "220ms", transitionTimingFunction: "cubic-bezier(0.4,0,0.2,1)" }}
      >
        <div className="flex items-center justify-between">
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink">
              {item?.subcategory || (imgUrl ? item?.category || "—" : "Analyzing…")}
          </span>
          {item?.color_primary && (
            <span
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: item.color_primary }}
            />
          )}
        </div>
      </div>
    </motion.div>
  );
}

function EmptyState({ onAdd, hasItems }: { onAdd: () => void; hasItems: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center py-32 text-center">
      <h2 className="font-display text-[28px] font-light text-graphite">
        {hasItems ? "Nothing here." : "Your wardrobe starts here."}
      </h2>
      <p className="mt-3 max-w-sm text-[14px] text-ink">
        {hasItems
          ? "Try a different filter, or add a new piece."
          : "Photograph each piece against a clean background. We do the rest."}
      </p>
      <motion.button
        {...tap}
        onClick={onAdd}
        className="mt-8 h-12 bg-graphite px-8 font-mono text-[12px] uppercase tracking-[0.08em] text-bone hover:bg-noir"
      >
        Add your first piece
      </motion.button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Multi-image upload sheet.
//
// Flow:
//   1. User picks one or many images (camera or gallery).
//   2. Each image is read into memory + thumb-prepared in parallel.
//   3. AI vision (Lovable AI Gateway) detects category/subcategory/etc per item.
//   4. User reviews the grid — can override any field, remove items, add more.
//   5. "Save all" uploads thumb + raw + bg-removed enhanced PNG and inserts a
//      wardrobe_items row per pending item, in parallel.
// ─────────────────────────────────────────────────────────────────────────────

type StagedStatus =
  | "decoding"   // reading file bytes + preparing thumb
  | "analyzing"  // calling AI vision
  | "ready"      // all set, awaiting Save
  | "saving"     // uploading + bg-remove + inserting
  | "done"       // saved
  | "error";     // failed (file unreadable etc.)

interface StagedItem {
  id: string;            // local id (also used as DB row id at save)
  file: File;            // in-memory file (after safe-file-read)
  previewUrl: string;    // object URL for the grid tile
  thumbDataUrl?: string; // small data URL used for AI vision (set after decode)
  status: StagedStatus;
  errorMsg?: string;
  category: Category | null;
  subcategory: string;
  formality: number;
  aiAnalysis?: {
    color_primary: string;
    color_secondary: string | null;
    material: string;
    season: string[];
    tags: string[];
  };
}


function UploadSheet({
  onClose,
}: {
  onClose: () => void;
  onPendingChange: (pending: PendingUploadItem | null) => void;
}) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const analyze = useServerFn(analyzeWardrobeItem);
  const [dragOver, setDragOver] = useState(false);
  const [items, setItems] = useState<StagedItem[]>([]);
  const [savingAll, setSavingAll] = useState(false);
  const [doneCount, setDoneCount] = useState(0);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const galleryInputRef = useRef<HTMLInputElement>(null);
  const dropInputRef = useRef<HTMLInputElement>(null);

  // Pre-warm bg-removal model as soon as the sheet opens.
  useEffect(() => {
    void warmBgRemoval();
  }, []);

  // Revoke object URLs on unmount so we don't leak memory.
  useEffect(() => {
    return () => {
      items.forEach((it) => URL.revokeObjectURL(it.previewUrl));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateItem = (id: string, patch: Partial<StagedItem>) =>
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));

  const removeItem = (id: string) =>
    setItems((prev) => {
      const target = prev.find((it) => it.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((it) => it.id !== id);
    });

  const resetInputs = () => {
    if (cameraInputRef.current) cameraInputRef.current.value = "";
    if (galleryInputRef.current) galleryInputRef.current.value = "";
    if (dropInputRef.current) dropInputRef.current.value = "";
  };

  /**
   * Build a small JPEG data URL (max 512px edge) from the in-memory file.
   * Used as the AI vision input — keeps payload small (~30-80KB) and removes
   * EXIF orientation issues.
   */
  const buildSmallDataUrl = async (file: File): Promise<string> => {
    const bitmap = await createImageBitmap(file).catch(() => null);
    if (!bitmap) {
      // Fallback: return the raw file as base64. Larger but works.
      const buf = await file.arrayBuffer();
      const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
      return `data:${file.type || "image/jpeg"};base64,${b64}`;
    }
    const maxEdge = 512;
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close();
      throw new Error("canvas 2d context unavailable");
    }
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    return canvas.toDataURL("image/jpeg", 0.78);
  };

  /**
   * For each picked file: read bytes → create staged item → kick off AI
   * analysis in parallel. The grid renders immediately.
   */
  const onFilesPicked = async (files: File[]) => {
    if (!files.length) return;
    resetInputs();

    const seeds: StagedItem[] = [];
    for (const raw of files) {
      try {
        const result = await readFileToBlob(raw);
        const inMemoryFile = blobToFile(result);
        const previewUrl = URL.createObjectURL(result.blob);
        seeds.push({
          id: crypto.randomUUID(),
          file: inMemoryFile,
          previewUrl,
          status: "decoding",
          category: null,
          subcategory: "",
          formality: 6,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Couldn't read photo";
        toast.error(`Skipped ${raw.name}`, { description: msg.slice(0, 120) });
      }
    }

    if (!seeds.length) return;
    setItems((prev) => [...prev, ...seeds]);

    // Run AI analysis for each new item in parallel.
    seeds.forEach((seed) => {
      void analyzeOne(seed);
    });
  };

  const analyzeOne = async (seed: StagedItem) => {
    try {
      const dataUrl = await buildSmallDataUrl(seed.file);
      updateItem(seed.id, { thumbDataUrl: dataUrl, status: "analyzing" });

      const res = await analyze({ data: { image_url: dataUrl } });
      if (!res.ok) {
        // AI failed — keep the item but require manual category.
        updateItem(seed.id, { status: "ready" });
        if (res.error === "rate_limited" || res.error === "payment_required") {
          toast.error(res.message);
        }
        return;
      }
      const a = res.analysis;
      updateItem(seed.id, {
        status: "ready",
        category: a.category,
        subcategory: a.subcategory,
        formality: snapFormality(a.formality_score),
        aiAnalysis: {
          color_primary: a.color_primary,
          color_secondary: a.color_secondary,
          material: a.material,
          season: a.season,
          tags: a.tags,
        },
      });
    } catch (err) {
      console.error("[analyze failed]", err);
      // Don't block the user — they can still manually categorize and save.
      updateItem(seed.id, { status: "ready" });
    }
  };

  /**
   * Upload + insert one staged item. Returns true on success.
   */
  const saveOne = async (item: StagedItem): Promise<boolean> => {
    if (!user || !item.category) return false;
    updateItem(item.id, { status: "saving" });

    try {
      const rawPath = `${user.id}/${item.id}.jpg`;
      const thumbPath = `${user.id}/${item.id}.jpg`;
      const enhancedPath = `${user.id}/${item.id}.png`;

      const { rawBlob, thumbBlob, placeholder } = await prepareUploadAssets(
        item.file,
        1600,
        0.9,
        0.85,
      );

      const thumbUp = await supabase.storage
        .from("wardrobe-thumbs")
        .upload(thumbPath, thumbBlob, { contentType: "image/jpeg", upsert: true });
      if (thumbUp.error) throw new UploadError(thumbUp.error.message, "UPLOAD THUMB");

      const rawUp = await supabase.storage
        .from("wardrobe-raw")
        .upload(rawPath, rawBlob, { contentType: "image/jpeg", upsert: true });
      if (rawUp.error) throw new UploadError(rawUp.error.message, "UPLOAD RAW");

      let enhancedPathToSave: string | null = null;
      try {
        const enhancedBlob = await removeBg(rawBlob);
        const enhancedUp = await supabase.storage
          .from("wardrobe-enhanced")
          .upload(enhancedPath, enhancedBlob, {
            contentType: "image/png",
            upsert: true,
          });
        if (!enhancedUp.error) enhancedPathToSave = enhancedPath;
      } catch (bgErr) {
        console.warn("[bg-removal skipped]", bgErr);
      }

      const a = item.aiAnalysis;
      const { error: insertErr } = await supabase.from("wardrobe_items").insert({
        id: item.id,
        user_id: user.id,
        raw_path: rawPath,
        thumbnail_path: thumbPath,
        enhanced_path: enhancedPathToSave,
        placeholder,
        category: item.category,
        subcategory: item.subcategory.trim() || null,
        formality_score: item.formality,
        color_primary: a?.color_primary ?? null,
        color_secondary: a?.color_secondary ?? null,
        material: a?.material ?? null,
        season: a?.season ?? [],
        tags: a?.tags ?? [],
      });
      if (insertErr) throw new DbInsertError(insertErr.message, "DB INSERT");

      updateItem(item.id, { status: "done" });
      setDoneCount((c) => c + 1);
      return true;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Save failed";
      const step = getStep(err, "SAVE FAILED");
      console.error("[save item failed]", { step, errorMessage, err });
      updateItem(item.id, { status: "error", errorMsg: `${step}: ${errorMessage.slice(0, 100)}` });
      return false;
    }
  };

  const handleSaveAll = async () => {
    if (!user || savingAll) return;
    const ready = items.filter((it) => it.status === "ready" && it.category);
    if (!ready.length) {
      toast.error("Pick a category for each item first.");
      return;
    }
    setSavingAll(true);
    setDoneCount(0);

    // Run uploads in parallel, but cap concurrency to 3 so we don't blow up
    // mobile memory / network.
    const queue = [...ready];
    let successes = 0;
    const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
      while (queue.length) {
        const next = queue.shift();
        if (!next) break;
        const ok = await saveOne(next);
        if (ok) successes++;
      }
    });
    await Promise.all(workers);

    qc.invalidateQueries({ queryKey: ["wardrobe", user.id] });
    setSavingAll(false);

    if (successes > 0) {
      toast(`Added ${successes} ${successes === 1 ? "piece" : "pieces"} to wardrobe`);
      setTimeout(() => onClose(), 600);
    } else {
      toast.error("Nothing saved.");
    }
  };

  const onPickGallery = () => galleryInputRef.current?.click();
  const onPickCamera = () => cameraInputRef.current?.click();

  const readyCount = items.filter((it) => it.status === "ready" && it.category).length;
  const analyzingCount = items.filter(
    (it) => it.status === "analyzing" || it.status === "decoding",
  ).length;
  const missingCategory = items.filter(
    (it) => (it.status === "ready" || it.status === "analyzing") && !it.category,
  ).length;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: dur.hover }}
      className="fixed inset-0 z-50 flex items-end justify-center bg-graphite/40"
      onClick={savingAll ? undefined : onClose}
    >
      <motion.div
        initial={{ y: "100%" }}
        animate={{ y: 0 }}
        exit={{ y: "100%" }}
        transition={{ duration: dur.page, ease: ease.luxury }}
        onClick={(e) => e.stopPropagation()}
        className="flex h-[90vh] w-full max-w-[1280px] flex-col bg-bone"
        style={{ borderRadius: "4px 4px 0 0" }}
      >
        {/* Header */}
        <div className="flex items-start justify-between border-b border-linen px-6 py-6">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink">
              {items.length === 0
                ? "New pieces"
                : `${items.length} ${items.length === 1 ? "piece" : "pieces"}`}
              {analyzingCount > 0 && ` · ${analyzingCount} analyzing`}
            </p>
            <h2 className="mt-2 font-display text-[28px] font-light text-graphite">
              Add to your wardrobe
            </h2>
          </div>
          <button
            onClick={onClose}
            disabled={savingAll}
            className="text-ink hover:text-graphite disabled:opacity-30"
            aria-label="Close"
          >
            <X className="h-5 w-5" strokeWidth={1.25} />
          </button>
        </div>

        {/* Hidden inputs */}
        <input
          ref={cameraInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          style={{ position: "absolute", opacity: 0, pointerEvents: "none", width: 1, height: 1 }}
          onChange={(e) => {
            const f = Array.from(e.target.files ?? []);
            if (f.length) void onFilesPicked(f);
          }}
        />
        <input
          ref={galleryInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
          multiple
          style={{ position: "absolute", opacity: 0, pointerEvents: "none", width: 1, height: 1 }}
          onChange={(e) => {
            const f = Array.from(e.target.files ?? []);
            if (f.length) void onFilesPicked(f);
          }}
        />
        <input
          ref={dropInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
          multiple
          style={{ position: "absolute", opacity: 0, pointerEvents: "none", width: 1, height: 1 }}
          onChange={(e) => {
            const f = Array.from(e.target.files ?? []);
            if (f.length) void onFilesPicked(f);
          }}
        />

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-6">
          {items.length === 0 ? (
            <>
              <div className="grid grid-cols-2 gap-4">
                <motion.button
                  {...tap}
                  onClick={onPickCamera}
                  className="flex flex-col items-center justify-center gap-3 border border-ink/40 bg-linen/30 py-10 transition-colors hover:border-graphite hover:bg-linen/60"
                >
                  <Camera className="h-7 w-7 text-graphite" strokeWidth={1.25} />
                  <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-graphite">
                    Take a photo
                  </span>
                </motion.button>
                <motion.button
                  {...tap}
                  onClick={onPickGallery}
                  className="flex flex-col items-center justify-center gap-3 border border-ink/40 bg-linen/30 py-10 transition-colors hover:border-graphite hover:bg-linen/60"
                >
                  <ImageIcon className="h-7 w-7 text-graphite" strokeWidth={1.25} />
                  <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-graphite">
                    Choose multiple
                  </span>
                </motion.button>
              </div>

              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  const f = Array.from(e.dataTransfer.files ?? []);
                  if (f.length) void onFilesPicked(f);
                }}
                onClick={() => dropInputRef.current?.click()}
                className={`mt-6 hidden h-40 cursor-pointer flex-col items-center justify-center border border-dashed transition-colors ${
                  dragOver ? "border-graphite bg-linen/40" : "border-ink/40"
                }`}
              >
                <UploadIcon className="h-6 w-6 text-ink" strokeWidth={1} />
                <p className="mt-3 font-mono text-[11px] uppercase tracking-[0.16em] text-ink">
                  Or drop several images here
                </p>
              </div>

              <p className="mt-6 text-center font-mono text-[10px] uppercase tracking-[0.16em] text-ink">
                JPG · PNG · WEBP · HEIC · 10 MB EACH
              </p>
              <p className="mt-2 text-center font-mono text-[10px] uppercase tracking-[0.16em] text-ink/60">
                AI will categorize each piece automatically
              </p>
            </>
          ) : (
            <>
              <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
                {items.map((item) => (
                  <StagedTile
                    key={item.id}
                    item={item}
                    disabled={savingAll}
                    onChange={(patch) => updateItem(item.id, patch)}
                    onRemove={() => removeItem(item.id)}
                  />
                ))}
                {!savingAll && (
                  <button
                    onClick={onPickGallery}
                    className="flex aspect-[3/4] flex-col items-center justify-center gap-2 border border-dashed border-ink/40 bg-linen/20 text-ink transition-colors hover:border-graphite hover:text-graphite"
                  >
                    <Plus className="h-6 w-6" strokeWidth={1.25} />
                    <span className="font-mono text-[10px] uppercase tracking-[0.16em]">
                      Add more
                    </span>
                  </button>
                )}
              </div>
            </>
          )}
        </div>

        {/* Footer — Save all */}
        {items.length > 0 && (
          <div className="border-t border-linen bg-bone px-6 py-4">
            <div className="flex items-center justify-between gap-4">
              <div className="font-mono text-[11px] uppercase tracking-[0.16em] text-ink">
                {savingAll
                  ? `Saving · ${doneCount}/${readyCount}`
                  : missingCategory > 0
                    ? `${missingCategory} need${missingCategory === 1 ? "s" : ""} a category`
                    : `${readyCount} ready to save`}
              </div>
              <div className="flex gap-3">
                <button
                  onClick={onClose}
                  disabled={savingAll}
                  className="font-mono text-[11px] uppercase tracking-[0.16em] text-ink hover:text-graphite disabled:opacity-30"
                >
                  Cancel
                </button>
                <motion.button
                  {...tap}
                  onClick={handleSaveAll}
                  disabled={savingAll || readyCount === 0}
                  className="h-12 bg-graphite px-8 font-mono text-[12px] uppercase text-bone hover:bg-noir disabled:opacity-30"
                  style={{ letterSpacing: "0.08em" }}
                >
                  {savingAll ? "Saving…" : `Save all (${readyCount})`}
                </motion.button>
              </div>
            </div>
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}

function StagedTile({
  item,
  disabled,
  onChange,
  onRemove,
}: {
  item: StagedItem;
  disabled: boolean;
  onChange: (patch: Partial<StagedItem>) => void;
  onRemove: () => void;
}) {
  const isBusy = item.status === "decoding" || item.status === "analyzing" || item.status === "saving";
  const statusLabel: Record<StagedStatus, string> = {
    decoding: "READING",
    analyzing: "AI ANALYZING",
    ready: "READY",
    saving: "SAVING",
    done: "SAVED",
    error: "ERROR",
  };

  return (
    <div className="flex flex-col gap-3 border border-ink/15 bg-linen/30 p-3">
      <div className="relative aspect-[3/4] overflow-hidden bg-linen">
        <img src={item.previewUrl} alt="" className="h-full w-full object-contain" />
        {isBusy && (
          <div className="absolute inset-0 bg-bone/60 backdrop-blur-[1px]">
            <div className="absolute inset-x-3 bottom-3 flex items-center justify-between border border-ink/20 bg-bone/95 px-3 py-2">
              <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-graphite">
                {statusLabel[item.status]}
              </span>
              <motion.span
                className="h-1.5 w-1.5 rounded-full bg-graphite"
                animate={{ opacity: [0.3, 1, 0.3] }}
                transition={{ duration: 1.2, repeat: Infinity, ease: "easeInOut" }}
              />
            </div>
          </div>
        )}
        {item.status === "done" && (
          <div className="absolute inset-0 flex items-center justify-center bg-graphite/60">
            <Check className="h-10 w-10 text-bone" strokeWidth={1.5} />
          </div>
        )}
        {!disabled && item.status !== "saving" && item.status !== "done" && (
          <button
            onClick={onRemove}
            className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full bg-bone/95 text-graphite shadow hover:bg-bone"
            aria-label="Remove"
          >
            <X className="h-3.5 w-3.5" strokeWidth={1.5} />
          </button>
        )}
      </div>

      {/* Per-tile editable fields */}
      <div className="flex flex-col gap-2">
        <select
          value={item.category ?? ""}
          disabled={disabled || item.status === "saving" || item.status === "done"}
          onChange={(e) => onChange({ category: (e.target.value || null) as Category | null })}
          className="h-9 w-full border border-ink/30 bg-bone px-2 font-mono text-[11px] uppercase tracking-[0.12em] text-graphite focus:border-graphite focus:outline-none disabled:opacity-50"
        >
          <option value="">Pick category…</option>
          {CATEGORY_OPTIONS.map((opt) => (
            <option key={opt.id} value={opt.id}>
              {opt.label}
            </option>
          ))}
        </select>

        <input
          type="text"
          value={item.subcategory}
          onChange={(e) => onChange({ subcategory: e.target.value })}
          disabled={disabled || item.status === "saving" || item.status === "done"}
          placeholder="Describe (optional)"
          className="h-9 w-full border border-ink/30 bg-bone px-2 font-mono text-[11px] text-graphite placeholder:text-ink/50 focus:border-graphite focus:outline-none disabled:opacity-50"
        />

        <div className="flex gap-1">
          {FORMALITY_OPTIONS.map(({ label, score }) => {
            const active = item.formality === score;
            return (
              <button
                key={score}
                disabled={disabled || item.status === "saving" || item.status === "done"}
                onClick={() => onChange({ formality: score })}
                className={`h-7 flex-1 rounded-full font-mono text-[9.5px] uppercase tracking-[0.14em] transition-colors disabled:opacity-50 ${
                  active
                    ? "bg-graphite text-bone"
                    : "border border-ink/40 text-ink hover:border-graphite hover:text-graphite"
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>

        {item.errorMsg && (
          <p className="font-mono text-[10px] text-noir">{item.errorMsg}</p>
        )}
      </div>
    </div>
  );
}

function EditSheet({
  item,
  onClose,
  onAdvance,
  hasMore,
}: {
  item: WardrobeItem | null;
  onClose: () => void;
  onAdvance: () => void;
  hasMore: boolean;
}) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const [category, setCategory] = useState<Category | null>(item?.category ?? null);
  const [subcategory, setSubcategory] = useState(item?.subcategory ?? "");
  const [formality, setFormality] = useState<number>(item?.formality_score ?? 6);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setCategory(item?.category ?? null);
    setSubcategory(item?.subcategory ?? "");
    setFormality(item?.formality_score ?? 6);
  }, [item?.id, item?.category, item?.subcategory, item?.formality_score]);

  if (!item) return null;

  const enhancedUrl = item.enhanced_path
    ? supabase.storage.from("wardrobe-enhanced").getPublicUrl(item.enhanced_path).data.publicUrl
    : null;
  const thumbUrl = item.thumbnail_path
    ? supabase.storage.from("wardrobe-thumbs").getPublicUrl(item.thumbnail_path).data.publicUrl
    : null;
  // Prefer the bg-removed enhanced PNG; fall back to the thumbnail if the
  // item was uploaded before bg-removal shipped.
  const previewUrl = enhancedUrl ?? thumbUrl;

  const finish = (advance: boolean) => {
    qc.invalidateQueries({ queryKey: ["wardrobe", user?.id] });
    if (advance && hasMore) onAdvance();
    else onClose();
  };

  const save = async () => {
    if (!category) return;
    setBusy(true);
    const { error } = await supabase
      .from("wardrobe_items")
      .update({
        category,
        subcategory: subcategory.trim() || null,
        formality_score: formality,
      })
      .eq("id", item.id);
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast("Saved");
    finish(true);
  };

  const archive = async () => {
    setBusy(true);
    const { error } = await supabase
      .from("wardrobe_items")
      .update({ archived: true })
      .eq("id", item.id);
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast("Archived");
    finish(false);
  };

  const remove = async () => {
    setBusy(true);
    const { error } = await supabase.from("wardrobe_items").delete().eq("id", item.id);
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast("Deleted");
    finish(false);
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: dur.hover }}
      className="fixed inset-0 z-50 flex items-end justify-center bg-graphite/40"
      onClick={busy ? undefined : onClose}
    >
      <motion.div
        initial={{ y: "100%" }}
        animate={{ y: 0 }}
        exit={{ y: "100%" }}
        transition={{ duration: dur.page, ease: ease.luxury }}
        onClick={(e) => e.stopPropagation()}
        className="h-[85vh] w-full max-w-[1280px] overflow-y-auto bg-bone px-6 py-8"
        style={{ borderRadius: "4px 4px 0 0" }}
      >
        <div className="flex items-start justify-between">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink">
              Edit piece
            </p>
            <h2 className="mt-2 font-display text-[28px] font-light text-graphite">
              {item.subcategory || item.category || "Untitled"}
            </h2>
          </div>
          <button
            onClick={onClose}
            disabled={busy}
            className="text-ink hover:text-graphite disabled:opacity-30"
            aria-label="Close"
          >
            <X className="h-5 w-5" strokeWidth={1.25} />
          </button>
        </div>

        {previewUrl && (
          <div
            className="mt-6 flex items-center justify-center bg-linen"
            style={{ height: "280px" }}
          >
            <img src={previewUrl} alt="Item" className="h-full w-full object-contain" />
          </div>
        )}

        <h3 className="mt-8 font-display text-[20px] font-light text-graphite">Category</h3>
        <div className="mt-4 grid grid-cols-2 gap-3">
          {CATEGORY_OPTIONS.slice(0, 6).map(({ id, label }) => {
            const active = category === id;
            return (
              <motion.button
                {...tap}
                key={id}
                onClick={() => setCategory(id)}
                className={`h-[64px] border text-[13px] uppercase tracking-[0.12em] ${
                  active
                    ? "border-graphite bg-graphite text-bone"
                    : "border-ink/40 bg-linen text-graphite hover:border-ink"
                }`}
                style={{ transitionDuration: "220ms", transitionTimingFunction: "cubic-bezier(0.16,1,0.3,1)" }}
              >
                {label}
              </motion.button>
            );
          })}
          <motion.button
            {...tap}
            onClick={() => setCategory("bag")}
            className={`col-span-2 h-[64px] border text-[13px] uppercase tracking-[0.12em] ${
              category === "bag"
                ? "border-graphite bg-graphite text-bone"
                : "border-ink/40 bg-linen text-graphite hover:border-ink"
            }`}
            style={{ transitionDuration: "220ms", transitionTimingFunction: "cubic-bezier(0.16,1,0.3,1)" }}
          >
            Bag
          </motion.button>
        </div>

        <input
          type="text"
          value={subcategory}
          onChange={(e) => setSubcategory(e.target.value)}
          placeholder="Describe it (optional)"
          className="mt-6 w-full border-0 border-b border-ink bg-transparent py-2 font-mono text-[13px] text-graphite placeholder:text-ink/60 focus:border-graphite focus:outline-none"
        />

        <div className="mt-6 flex gap-2">
          {FORMALITY_OPTIONS.map(({ label, score }) => {
            const active = formality === score;
            return (
              <motion.button
                {...tap}
                key={score}
                onClick={() => setFormality(score)}
                className={`h-9 flex-1 rounded-full px-4 font-mono text-[11px] uppercase tracking-[0.16em] transition-colors ${
                  active
                    ? "bg-graphite text-bone"
                    : "border border-ink text-ink hover:border-graphite hover:text-graphite"
                }`}
              >
                {label}
              </motion.button>
            );
          })}
        </div>

        <motion.button
          {...tap}
          onClick={save}
          disabled={busy || !category}
          className="mt-8 h-12 w-full bg-graphite font-mono text-[12px] uppercase text-bone hover:bg-noir disabled:opacity-30"
          style={{ letterSpacing: "0.08em" }}
        >
          {hasMore ? "Save & next" : "Save"}
        </motion.button>

        <div className="mt-6 flex items-center justify-between border-t border-linen pt-6">
          <button
            onClick={archive}
            disabled={busy}
            className="font-mono text-[11px] uppercase tracking-[0.16em] text-ink hover:text-graphite disabled:opacity-30"
          >
            Archive
          </button>
          <button
            onClick={remove}
            disabled={busy}
            className="font-mono text-[11px] uppercase tracking-[0.16em] text-noir hover:opacity-70 disabled:opacity-30"
          >
            Delete
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// EntryChoiceSheet — asked first when user taps "+". Routes them to the
// single-piece UploadSheet or the multi-piece SetWizard.
// ─────────────────────────────────────────────────────────────────────────────
function EntryChoiceSheet({
  onPickSingle,
  onPickSet,
  onClose,
}: {
  onPickSingle: () => void;
  onPickSet: () => void;
  onClose: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: dur.hover }}
      className="fixed inset-0 z-50 flex items-end justify-center bg-graphite/40"
      onClick={onClose}
    >
      <motion.div
        initial={{ y: "100%" }}
        animate={{ y: 0 }}
        exit={{ y: "100%" }}
        transition={{ duration: dur.page, ease: ease.luxury }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[640px] bg-bone px-6 py-8"
        style={{ borderRadius: "4px 4px 0 0" }}
      >
        <div className="flex items-start justify-between">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink">
              Add to wardrobe
            </p>
            <h2 className="mt-2 font-display text-[28px] font-light text-graphite">
              Is this part of a set?
            </h2>
          </div>
          <button onClick={onClose} className="text-ink hover:text-graphite" aria-label="Close">
            <X className="h-5 w-5" strokeWidth={1.25} />
          </button>
        </div>

        <div className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <motion.button
            {...tap}
            onClick={onPickSingle}
            className="flex flex-col items-start gap-3 border border-ink/30 bg-linen/30 p-6 text-left transition-colors hover:border-graphite hover:bg-linen/60"
          >
            <Shirt className="h-7 w-7 text-graphite" strokeWidth={1.25} />
            <div>
              <p className="font-display text-[18px] font-light text-graphite">Single piece</p>
              <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.16em] text-ink">
                One garment at a time
              </p>
            </div>
          </motion.button>

          <motion.button
            {...tap}
            onClick={onPickSet}
            className="flex flex-col items-start gap-3 border border-ink/30 bg-linen/30 p-6 text-left transition-colors hover:border-graphite hover:bg-linen/60"
          >
            <Layers className="h-7 w-7 text-graphite" strokeWidth={1.25} />
            <div>
              <p className="font-display text-[18px] font-light text-graphite">Part of a set</p>
              <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.16em] text-ink">
                Suit · agbada · tracksuit
              </p>
            </div>
          </motion.button>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SetTile — single hero piece (largest piece chosen by role priority) with a
// "SET · N" badge corner. Tapping opens a quick detail view (placeholder for
// now — full set edit sheet ships in a follow-up).
// ─────────────────────────────────────────────────────────────────────────────
const ROLE_PRIORITY: Record<string, number> = {
  agbada_robe: 100,
  jacket: 90,
  outerwear: 90,
  kaftan_top: 80,
  tracksuit_top: 70,
  buba_top: 60,
  top: 50,
  shirt: 50,
  waistcoat: 40,
  trouser: 30,
  bottom: 30,
  sokoto_trouser: 30,
  kaftan_bottom: 30,
  tracksuit_bottom: 30,
  overlay: 20,
};

function SetTile({
  set,
  pieces,
  index,
}: {
  set: GarmentSet;
  pieces: WardrobeItem[];
  index: number;
}) {
  const stagger = Math.min(index, 17) * 0.035;

  // Pick the hero piece — highest role priority, falling back to first piece
  const hero = useMemo(() => {
    if (pieces.length === 0) return null;
    return [...pieces].sort(
      (a, b) =>
        (ROLE_PRIORITY[b.set_role ?? ""] ?? 0) - (ROLE_PRIORITY[a.set_role ?? ""] ?? 0),
    )[0];
  }, [pieces]);

  const heroUrl = hero?.enhanced_path
    ? supabase.storage.from("wardrobe-enhanced").getPublicUrl(hero.enhanced_path).data.publicUrl
    : hero?.thumbnail_path
      ? supabase.storage.from("wardrobe-thumbs").getPublicUrl(hero.thumbnail_path).data.publicUrl
      : null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: stagger, duration: dur.page, ease: ease.luxury }}
      whileHover={{ scale: 1.02 }}
      className="group relative aspect-[3/4] cursor-pointer bg-linen p-3"
    >
      {heroUrl ? (
        <img
          src={heroUrl}
          alt={set.name ?? "Set"}
          loading="lazy"
          className="h-full w-full object-contain"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-ink/40">
          <Layers className="h-8 w-8" strokeWidth={1.25} />
        </div>
      )}

      {/* Set badge */}
      <div className="absolute left-3 top-3 flex items-center gap-1.5 border border-graphite bg-bone/95 px-2 py-1">
        <Layers className="h-3 w-3 text-graphite" strokeWidth={1.5} />
        <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-graphite">
          SET · {pieces.length}
        </span>
      </div>

      {/* Meta bar */}
      <div
        className="absolute inset-x-0 bottom-0 translate-y-full bg-bone/95 px-3 py-2 transition-transform group-hover:translate-y-0"
        style={{ transitionDuration: "220ms", transitionTimingFunction: "cubic-bezier(0.4,0,0.2,1)" }}
      >
        <div className="flex items-center justify-between">
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-graphite truncate">
            {set.name ?? set.set_type ?? "Set"}
          </span>
          {set.formality_score && (
            <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-ink">
              F{set.formality_score}
            </span>
          )}
        </div>
      </div>
    </motion.div>
  );
}
