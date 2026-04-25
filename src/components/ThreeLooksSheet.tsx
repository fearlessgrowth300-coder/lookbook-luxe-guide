// Full-screen bottom-sheet modal that replaces the /today/looks route.
// Mounts over Today, shows a horizontal pager of 3 Looks, drag-down to dismiss.
import {
  motion,
  AnimatePresence,
  useMotionValue,
  type PanInfo,
} from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Shuffle,
  Bookmark,
  Check,
  ArrowRight,
  Share2,
  Plus,
  User,
} from "lucide-react";
import { toast } from "sonner";
import { LookHero } from "@/components/LookHero";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/integrations/supabase/client";
import { ease, tap } from "@/lib/motion";
import { suggestOutfit } from "@/server/functions/suggestOutfit";
import { generateMannequin } from "@/server/functions/generateMannequin";
import { type Occasion } from "@/server/mock-ai";

const OCCASIONS: Occasion[] = [
  "office",
  "casual",
  "evening",
  "athletic",
  "formal",
  "travel",
];

interface ItemFull {
  id: string;
  thumbnail_path: string | null;
  enhanced_path: string | null;
  category: string | null;
  subcategory: string | null;
  color_primary: string | null;
  material: string | null;
  formality_score: number | null;
}

interface OutfitRecord {
  id: string;
  item_ids: string[];
  rationale: string | null;
  occasion: string | null;
  saved: boolean | null;
  name: string | null;
  look_sequence: number | null;
  batch_id: string | null;
  render_path: string | null;
  render_status: string | null;
  mannequin_path: string | null;
  mannequin_status: string | null;
  context: Record<string, unknown> | null;
}

export function ThreeLooksSheet({
  open,
  batchId,
  onClose,
  onBatchChanged,
}: {
  open: boolean;
  batchId: string | null;
  onClose: () => void;
  /** Called when shuffle replaces the batch with a new one */
  onBatchChanged?: (newBatchId: string) => void;
}) {
  return (
    <AnimatePresence>
      {open && batchId ? (
        <SheetInner
          batchId={batchId}
          onClose={onClose}
          onBatchChanged={onBatchChanged}
        />
      ) : null}
    </AnimatePresence>
  );
}

function SheetInner({
  batchId,
  onClose,
  onBatchChanged,
}: {
  batchId: string;
  onClose: () => void;
  onBatchChanged?: (newBatchId: string) => void;
}) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const [shuffling, setShuffling] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const pagerRef = useRef<HTMLDivElement>(null);
  const dragY = useMotionValue(0);

  // Lock body scroll while open
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Hardware back / Escape key dismiss.
  // Use a ref for onClose so this effect runs ONCE on mount — otherwise an
  // unstable parent callback would tear down the listener (and crucially, fire
  // its cleanup which pops the history state we just pushed) on every render,
  // closing the sheet immediately after it opens.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCloseRef.current();
    }
    // Push a sentinel history entry so the back gesture closes the sheet
    // rather than navigating away from /today. Track it so cleanup can tell
    // whether the user already popped it (Back button) vs closed via UI.
    let sentinelLive = true;
    window.history.pushState({ sheet: "three-looks" }, "");
    function onPop() {
      // Only react when leaving OUR sentinel — ignore unrelated popstates
      // (e.g. nested navigations, browser quirks, Strict Mode replays).
      sentinelLive = false;
      onCloseRef.current();
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("popstate", onPop);
      // If the sentinel is still on top of the stack (closed via UI, not Back),
      // pop it so we don't leak history entries or cause a stuck Back button.
      if (sentinelLive && window.history.state?.sheet === "three-looks") {
        window.history.back();
      }
    };
  }, []);

  const wardrobeQuery = useQuery({
    queryKey: ["wardrobe-full", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data } = await supabase
        .from("wardrobe_items")
        .select(
          "id, thumbnail_path, enhanced_path, category, subcategory, color_primary, material, formality_score",
        )
        .eq("user_id", user!.id)
        .eq("archived", false);
      return (data ?? []) as ItemFull[];
    },
  });

  const itemsById = useMemo(() => {
    const map = new Map<string, ItemFull>();
    (wardrobeQuery.data ?? []).forEach((i) => map.set(i.id, i));
    return map;
  }, [wardrobeQuery.data]);

  const batchQuery = useQuery({
    queryKey: ["outfit-batch", batchId],
    enabled: !!batchId && !!user,
    refetchInterval: (query) => {
      const data = query.state.data as OutfitRecord[] | undefined;
      if (!data || data.length === 0) return 4000;
      // Poll while any look has a "see on me" generation in flight.
      const mannequinPending = data.some(
        (o) => o.mannequin_status === "rendering",
      );
      return mannequinPending ? 3000 : false;
    },
    queryFn: async () => {
      const { data, error } = await supabase
        .from("outfits")
        .select(
          "id, item_ids, rationale, occasion, saved, name, look_sequence, batch_id, render_path, render_status, mannequin_path, mannequin_status, context",
        )
        .eq("batch_id", batchId)
        .order("look_sequence", { ascending: true });
      if (error) throw error;
      return (data ?? []) as OutfitRecord[];
    },
  });

  const outfits = batchQuery.data ?? [];

  // Tracks which outfits have an in-flight "see on me" mannequin generation
  // initiated from this client. Cleared when the row reports ready/failed.
  const mannequinInFlightRef = useRef<Set<string>>(new Set());

  async function handleSeeOnMe(outfitId: string) {
    if (mannequinInFlightRef.current.has(outfitId)) return;
    mannequinInFlightRef.current.add(outfitId);
    // Optimistic UI: flip status so LookHero shows shimmer immediately.
    qc.setQueryData(
      ["outfit-batch", batchId],
      (current: OutfitRecord[] | undefined) =>
        current?.map((entry) =>
          entry.id === outfitId
            ? { ...entry, mannequin_status: "rendering" }
            : entry,
        ) ?? current,
    );
    try {
      const result = await generateMannequin({ data: { outfit_id: outfitId } });
      if ("error" in result) {
        toast("Couldn't compose figure. Try again.");
        console.error("[generateMannequin] error", result);
      }
    } catch (err) {
      console.error("[generateMannequin] threw", err);
      toast("Couldn't compose figure.");
    } finally {
      mannequinInFlightRef.current.delete(outfitId);
      qc.invalidateQueries({ queryKey: ["outfit-batch", batchId] });
    }
  }

  const effectiveOccasion: Occasion = useMemo(() => {
    const fromBatch = outfits[0]?.occasion;
    if (fromBatch && (OCCASIONS as string[]).includes(fromBatch)) {
      return fromBatch as Occasion;
    }
    return "office";
  }, [outfits]);

  // Track which look is centered via scroll position
  useEffect(() => {
    const el = pagerRef.current;
    if (!el) return;
    function onScroll() {
      if (!el) return;
      const i = Math.round(el.scrollLeft / el.clientWidth);
      setActiveIndex((prev) => (prev !== i ? i : prev));
    }
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [outfits.length]);

  function jumpTo(i: number) {
    const el = pagerRef.current;
    if (!el) return;
    el.scrollTo({ left: i * el.clientWidth, behavior: "smooth" });
  }

  async function handleShuffle() {
    if (shuffling) return;
    setShuffling(true);
    try {
      const result = await suggestOutfit({
        data: { occasion: effectiveOccasion, temp_c: 14 },
      });
      if ("error" in result) {
        toast("Couldn't reshuffle. Try again.");
        return;
      }
      onBatchChanged?.(result.batch_id);
      qc.invalidateQueries({ queryKey: ["recent-outfits"] });
    } catch {
      toast("Couldn't reshuffle.");
    } finally {
      setShuffling(false);
    }
  }

  function handleDragEnd(_e: unknown, info: PanInfo) {
    if (info.offset.y > 100 || info.velocity.y > 600) {
      onClose();
    } else {
      // Snap back
      dragY.set(0);
    }
  }

  // Build panels
  const panels = useMemo(() => {
    const list: Array<
      | { kind: "look"; outfit: OutfitRecord; index: number }
      | { kind: "invite"; index: number }
    > = [];
    outfits.forEach((o, i) => list.push({ kind: "look", outfit: o, index: i }));
    while (list.length < 3 && outfits.length > 0) {
      list.push({ kind: "invite", index: list.length });
    }
    return list;
  }, [outfits]);

  const loading = batchQuery.isLoading || wardrobeQuery.isLoading;
  const activeOutfit =
    panels[activeIndex]?.kind === "look"
      ? (panels[activeIndex] as { kind: "look"; outfit: OutfitRecord }).outfit
      : null;

  // Inspiration status (from server function), persisted on the outfit's
  // `context.inspiration` field. Best-effort enrichment — absence is fine.
  const inspiration = useMemo(() => {
    const ctx = outfits[0]?.context as
      | { inspiration?: Record<string, unknown> }
      | null
      | undefined;
    const insp = ctx?.inspiration;
    if (!insp || typeof insp !== "object") return null;
    const state = (insp as { state?: unknown }).state;
    if (state === "fresh" || state === "cached") {
      const pinCount = Number((insp as { pin_count?: unknown }).pin_count ?? 0);
      const palette = Array.isArray((insp as { palette?: unknown }).palette)
        ? ((insp as { palette: string[] }).palette ?? [])
        : [];
      return {
        kind: state as "fresh" | "cached",
        label:
          state === "fresh"
            ? `Inspired by ${pinCount} fresh references`
            : `Inspired by ${pinCount} cached references`,
        palette: palette.slice(0, 3),
      };
    }
    if (state === "failed" || state === "skipped") {
      const reason = String((insp as { reason?: unknown }).reason ?? "unknown");
      return {
        kind: "failed" as const,
        label:
          state === "skipped"
            ? "Pinterest inspiration disabled"
            : `Pinterest inspiration unavailable (${reason.slice(0, 40)})`,
        palette: [],
      };
    }
    return null;
  }, [outfits]);

  return (
    <div className="fixed inset-0 z-50">
      {/* Dim overlay */}
      <motion.button
        type="button"
        aria-label="Close"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.22, ease: ease.tactile }}
        onClick={onClose}
        className="absolute inset-0 bg-noir/40"
        style={{ touchAction: "none" }}
      />

      {/* Sheet */}
      <motion.div
        initial={{ y: "100%" }}
        animate={{ y: 0 }}
        exit={{ y: "100%" }}
        transition={{ duration: 0.48, ease: ease.luxury }}
        drag="y"
        dragConstraints={{ top: 0, bottom: 0 }}
        dragElastic={{ top: 0, bottom: 0.4 }}
        style={{ y: dragY }}
        onDragEnd={handleDragEnd}
        className="absolute inset-x-0 bottom-0 flex h-[100dvh] flex-col bg-bone"
      >
        {/* Top strip — sticky 56px */}
        <header
          className="relative flex h-14 shrink-0 flex-col items-stretch border-b border-linen bg-bone"
          // Make the entire header a drag handle
          style={{ touchAction: "none" }}
        >
          {/* Drag handle */}
          <div className="flex justify-center pt-3">
            <span
              aria-hidden
              className="block h-1 w-10 rounded-full"
              style={{ background: "color-mix(in oklab, var(--ink) 20%, transparent)" }}
            />
          </div>

          <div className="flex flex-1 items-center px-4">
            <p className="w-1/3 font-mono text-[10px] uppercase tracking-[0.2em] text-ink">
              Three looks
            </p>
            <div className="flex w-1/3 items-center justify-center gap-1.5">
              {panels.map((_, i) => (
                <button
                  key={i}
                  onClick={() => jumpTo(i)}
                  aria-label={`Go to ${i + 1}`}
                  className="h-1.5 w-1.5 rounded-full transition-colors"
                  style={{
                    backgroundColor:
                      activeIndex === i ? "var(--graphite)" : "var(--linen)",
                  }}
                />
              ))}
            </div>
            <div className="flex w-1/3 justify-end">
              <motion.button
                {...tap}
                onClick={handleShuffle}
                disabled={shuffling || loading || outfits.length === 0}
                aria-label="Shuffle"
                className="flex h-8 w-8 items-center justify-center text-ink transition-colors hover:text-graphite disabled:opacity-40"
              >
                <motion.span
                  animate={shuffling ? { rotate: 360 } : { rotate: 0 }}
                  transition={{ duration: 0.6, ease: ease.luxury }}
                  className="inline-flex"
                >
                  <Shuffle className="h-4 w-4" strokeWidth={1.5} />
                </motion.span>
              </motion.button>
            </div>
          </div>
        </header>

        {/* Inspiration status — slim bar showing whether Pinterest cues
            were folded into the prompt. Best-effort enrichment, never required. */}
        {inspiration && (
          <div
            className="flex shrink-0 items-center justify-center gap-2 border-b border-linen bg-bone px-4 py-1.5"
            title={inspiration.label}
          >
            <span
              aria-hidden
              className="inline-block h-1.5 w-1.5 rounded-full"
              style={{
                backgroundColor:
                  inspiration.kind === "failed"
                    ? "color-mix(in oklab, var(--ink) 35%, transparent)"
                    : "var(--graphite)",
              }}
            />
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink/70">
              {inspiration.label}
            </p>
            {inspiration.palette.length > 0 && (
              <span className="font-mono text-[10px] tracking-[0.12em] text-ink/50">
                · {inspiration.palette.join(" / ")}
              </span>
            )}
          </div>
        )}

        {/* Body */}
        {loading ? (
          <div className="flex flex-1 items-center justify-center">
            <ComposingDots />
          </div>
        ) : outfits.length === 0 ? (
          <EmptyState
            onAdd={() => {
              onClose();
              navigate({ to: "/wardrobe" });
            }}
          />
        ) : (
          <div
            ref={pagerRef}
            className="atelier-pager flex flex-1 snap-x snap-mandatory overflow-x-auto overflow-y-hidden"
            style={{ scrollbarWidth: "none" }}
          >
            {panels.map((p, i) =>
              p.kind === "look" ? (
                <LookPanel
                  key={p.outfit.id}
                  outfit={p.outfit}
                  index={p.index}
                  items={
                    (p.outfit.item_ids ?? [])
                      .map((id) => itemsById.get(id))
                      .filter(Boolean) as ItemFull[]
                  }
                  isActive={activeIndex === i}
                  mannequinLoading={p.outfit.mannequin_status === "rendering"}
                />
              ) : (
                <InvitePanel
                  key={`invite-${i}`}
                  index={p.index}
                  onAdd={() => {
                    onClose();
                    navigate({ to: "/wardrobe" });
                  }}
                />
              ),
            )}
          </div>
        )}

        {/* Sticky bottom action row */}
        {activeOutfit && (
          <ActionRow
            outfit={activeOutfit}
            mannequinLoading={
              activeOutfit.mannequin_status === "rendering" ||
              mannequinInFlightRef.current.has(activeOutfit.id)
            }
            onSeeOnMe={() => handleSeeOnMe(activeOutfit.id)}
            onDetails={() => {
              // Navigate FIRST. Closing the sheet via onClose triggers a
              // ?batch= cleanup navigate to /today which races with this one
              // and sometimes wins (replace:true), bouncing the user back.
              // Just close the store state — the route change unmounts the
              // sheet naturally.
              navigate({
                to: "/outfit/$id",
                params: { id: activeOutfit.id },
              });
            }}
          />
        )}

        <style>{`.atelier-pager::-webkit-scrollbar{display:none}`}</style>
      </motion.div>
    </div>
  );
}

/* ─────────────────────────── Action row ─────────────────────────── */

function ActionRow({
  outfit,
  mannequinLoading,
  onSeeOnMe,
  onDetails,
}: {
  outfit: OutfitRecord;
  mannequinLoading: boolean;
  onSeeOnMe: () => void;
  onDetails: () => void;
}) {
  const [saved, setSaved] = useState(outfit.saved ?? false);

  // Sync if outfit changes (different look becomes active)
  useEffect(() => {
    setSaved(outfit.saved ?? false);
  }, [outfit.id, outfit.saved]);

  async function handleSave() {
    const next = !saved;
    setSaved(next);
    await supabase.from("outfits").update({ saved: next }).eq("id", outfit.id);
    navigator.vibrate?.(8);
    toast(next ? "Saved" : "Removed");
  }

  async function handleWear() {
    const today = new Date().toISOString().slice(0, 10);
    await supabase.from("outfits").update({ worn_on: today }).eq("id", outfit.id);
    navigator.vibrate?.(8);
    toast("Noted.");
  }

  async function handleShare() {
    const url = `${window.location.origin}/outfit/${outfit.id}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: outfit.name ?? "Look", url });
      } catch {
        /* cancelled */
      }
    } else {
      await navigator.clipboard.writeText(url);
      toast("Link copied");
    }
  }

  const hasMannequin = !!outfit.mannequin_path;

  return (
    <div className="flex h-14 shrink-0 items-stretch border-t border-linen bg-bone">
      <ActionIcon
        label={hasMannequin ? "ON ME" : "SEE ON ME"}
        active={hasMannequin}
        disabled={mannequinLoading}
        icon={<User className="h-5 w-5" strokeWidth={1.5} />}
        onClick={onSeeOnMe}
      />
      <ActionIcon
        label="SAVE"
        active={saved}
        icon={
          <Bookmark
            className="h-5 w-5"
            strokeWidth={1.5}
            fill={saved ? "currentColor" : "none"}
          />
        }
        onClick={handleSave}
      />
      <ActionIcon
        label="WEAR"
        icon={<Check className="h-5 w-5" strokeWidth={1.5} />}
        onClick={handleWear}
      />
      <ActionIcon
        label="DETAILS"
        icon={<ArrowRight className="h-5 w-5" strokeWidth={1.5} />}
        onClick={onDetails}
      />
      <ActionIcon
        label="SHARE"
        icon={<Share2 className="h-5 w-5" strokeWidth={1.5} />}
        onClick={handleShare}
      />
    </div>
  );
}

function ActionIcon({
  label,
  icon,
  active,
  disabled,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <motion.button
      {...tap}
      onClick={onClick}
      disabled={disabled}
      className="flex flex-1 flex-col items-center justify-center gap-1 disabled:opacity-50"
      aria-label={label}
    >
      <span
        className="transition-colors"
        style={{ color: active ? "var(--graphite)" : "var(--ink)" }}
      >
        {icon}
      </span>
      <span
        className="font-mono text-[9px] uppercase tracking-[0.16em] transition-colors"
        style={{ color: active ? "var(--graphite)" : "var(--ink)" }}
      >
        {label}
      </span>
    </motion.button>
  );
}

/* ─────────────────────────── Look panel ─────────────────────────── */

function LookPanel({
  outfit,
  index,
  items,
  isActive,
  mannequinLoading,
}: {
  outfit: OutfitRecord;
  index: number;
  items: ItemFull[];
  isActive: boolean;
  mannequinLoading: boolean;
}) {
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    if (isActive && !revealed) {
      const t = setTimeout(() => setRevealed(true), 80);
      return () => clearTimeout(t);
    }
  }, [isActive, revealed]);

  return (
    <section
      data-look-index={index}
      className="relative flex h-full shrink-0 snap-center snap-always flex-col"
      style={{
        // Each panel: full viewport width minus 32px of horizontal padding
        // so neighboring panels peek slightly at the edges.
        flexBasis: "calc(100vw - 32px)",
        marginLeft: index === 0 ? "16px" : "8px",
        marginRight: "8px",
        background:
          "linear-gradient(180deg, var(--linen) 0%, color-mix(in oklab, var(--linen), var(--ink) 4%) 100%)",
      }}
    >
      {/* Top: eyebrow + name */}
      <div className="px-4 pt-8 text-center">
        <motion.p
          initial={{ opacity: 0, y: 6 }}
          animate={revealed ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.42, ease: ease.luxury }}
          className="font-mono text-[11px] uppercase tracking-[0.24em] text-ink"
        >
          LOOK {String(index + 1).padStart(2, "0")}
        </motion.p>
        <motion.h2
          initial={{ opacity: 0, y: 8 }}
          animate={revealed ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.52, delay: 0.08, ease: ease.luxury }}
          className="mt-3 line-clamp-2 font-display text-[28px] font-normal leading-[1.1] text-graphite"
        >
          {outfit.name ?? `Look ${index + 1}`}
        </motion.h2>
      </div>

      {/* Composition zone — LookHero with callout labels */}
      <div className="relative flex flex-1 items-center justify-center overflow-hidden px-1 py-2">
        <LookHero
          outfit={outfit}
          items={items}
          revealed={revealed}
          size="md"
          mannequinLoading={mannequinLoading}
        />
      </div>

      {/* Rationale */}
      {outfit.rationale && (
        <motion.p
          initial={{ opacity: 0 }}
          animate={revealed ? { opacity: 1 } : {}}
          transition={{ duration: 0.5, delay: 0.7, ease: ease.luxury }}
          className="mx-auto mb-4 max-w-[320px] px-6 pt-2 text-center font-display text-[17px] font-light italic leading-[1.45] text-graphite"
          style={{
            display: "-webkit-box",
            WebkitLineClamp: 3,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {outfit.rationale}
        </motion.p>
      )}
    </section>
  );
}

/* ─────────────────────────── Invite panel ─────────────────────────── */

function InvitePanel({
  index,
  onAdd,
}: {
  index: number;
  onAdd: () => void;
}) {
  return (
    <section
      data-look-index={index}
      className="relative flex h-full shrink-0 snap-center snap-always flex-col items-center justify-center px-8"
      style={{
        flexBasis: "calc(100vw - 32px)",
        marginLeft: index === 0 ? "16px" : "8px",
        marginRight: "8px",
        background:
          "linear-gradient(180deg, var(--linen) 0%, color-mix(in oklab, var(--linen), var(--ink) 4%) 100%)",
      }}
    >
      <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-ink">
        LOOK {String(index + 1).padStart(2, "0")}
      </p>
      <h3 className="mt-6 max-w-[360px] text-center font-display text-[26px] font-light leading-[1.15] text-graphite">
        One more piece unlocks Look {String(index + 1).padStart(2, "0")}.
      </h3>
      <p className="mt-4 max-w-[300px] text-center text-[14px] leading-relaxed text-ink">
        Add another item to compose another variation.
      </p>
      <motion.button
        {...tap}
        onClick={onAdd}
        className="mt-8 flex h-12 items-center gap-2 border border-ink px-6 text-[13px] text-graphite transition-colors hover:bg-graphite hover:text-bone"
      >
        <Plus className="h-4 w-4" strokeWidth={1.5} />
        Add a piece
      </motion.button>
    </section>
  );
}

/* ─────────────────────────── Helpers ─────────────────────────── */

function ComposingDots() {
  return (
    <div className="flex flex-col items-center gap-4">
      <span className="inline-flex items-center gap-2">
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className="block h-1.5 w-1.5 rounded-full bg-graphite"
            animate={{ opacity: [0.3, 1, 0.3] }}
            transition={{
              duration: 1.2,
              repeat: Infinity,
              delay: i * 0.16,
              ease: ease.drift,
            }}
          />
        ))}
      </span>
      <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-ink">
        Composing
      </p>
    </div>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <section className="flex flex-1 items-center justify-center px-6">
      <div className="max-w-[420px] text-center">
        <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-ink">
          Nothing composed yet
        </p>
        <h1 className="mt-6 font-display text-[28px] font-light leading-[1.2] text-graphite">
          Pick an occasion on Today.
        </h1>
        <motion.button
          {...tap}
          onClick={onAdd}
          className="mt-8 h-12 border border-ink px-8 text-[13px] text-graphite transition-colors hover:bg-graphite hover:text-bone"
        >
          Add a piece
        </motion.button>
      </div>
    </section>
  );
}
