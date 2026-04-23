import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { motion, AnimatePresence } from "framer-motion";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  Shuffle,
  Bookmark,
  Check,
  ArrowRight,
  Share2,
  Plus,
} from "lucide-react";
import { toast } from "sonner";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/integrations/supabase/client";
import { ease, dur, tap } from "@/lib/motion";
import { suggestOutfit } from "@/server/functions/suggestOutfit";
import { renderOutfit } from "@/server/functions/renderOutfit";
import { type Occasion } from "@/server/mock-ai";

const OCCASIONS: Occasion[] = [
  "office",
  "casual",
  "evening",
  "athletic",
  "formal",
  "travel",
];

export const Route = createFileRoute("/today/looks")({
  component: () => (
    <ProtectedRoute>
      <ThreeLooksPage />
    </ProtectedRoute>
  ),
  validateSearch: (
    search: Record<string, unknown>,
  ): { occasion?: Occasion; batch?: string } => {
    const occ = search.occasion;
    const validOcc =
      typeof occ === "string" && (OCCASIONS as string[]).includes(occ)
        ? (occ as Occasion)
        : undefined;
    const batch = typeof search.batch === "string" ? search.batch : undefined;
    return { occasion: validOcc, batch };
  },
  head: () => ({ meta: [{ title: "Three Looks — Atelier" }] }),
});

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
}

function ThreeLooksPage() {
  const { occasion: searchOccasion, batch: searchBatch } = Route.useSearch();
  const { user } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const [outfits, setOutfits] = useState<OutfitRecord[]>([]);
  const [shuffling, setShuffling] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const pagerRef = useRef<HTMLDivElement>(null);

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
    queryKey: ["outfit-batch", searchBatch],
    enabled: !!searchBatch && !!user,
    // Poll every 4s while any outfit is still rendering
    refetchInterval: (query) => {
      const data = query.state.data as OutfitRecord[] | undefined;
      if (!data || data.length === 0) return 4000;
      const stillPending = data.some(
        (o) =>
          !o.render_path &&
          o.render_status !== "failed",
      );
      return stillPending ? 4000 : false;
    },
    queryFn: async () => {
      const { data, error } = await supabase
        .from("outfits")
        .select(
          "id, item_ids, rationale, occasion, saved, name, look_sequence, batch_id, render_path, render_status",
        )
        .eq("batch_id", searchBatch!)
        .order("look_sequence", { ascending: true });
      if (error) throw error;
      return (data ?? []) as OutfitRecord[];
    },
  });

  // Trigger AI render for each outfit that hasn't started yet (fire-and-forget,
  // sequential to keep gateway load low). Each id is requested only once per
  // mount via the requestedRef.
  const requestedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!batchQuery.data || batchQuery.data.length === 0) return;
    const toRender = batchQuery.data.filter(
      (o) =>
        !o.render_path &&
        o.render_status !== "rendering" &&
        o.render_status !== "failed" &&
        !requestedRef.current.has(o.id),
    );
    if (toRender.length === 0) return;

    (async () => {
      for (const o of toRender) {
        if (requestedRef.current.has(o.id)) continue;
        requestedRef.current.add(o.id);
        try {
          await renderOutfit({ data: { outfit_id: o.id } });
          qc.invalidateQueries({ queryKey: ["outfit-batch", searchBatch] });
        } catch (err) {
          console.error("[renderOutfit] failed for", o.id, err);
        }
      }
    })();
  }, [batchQuery.data, qc, searchBatch]);

  // Keep local state synced with the (possibly polling) query
  useEffect(() => {
    if (batchQuery.data) setOutfits(batchQuery.data);
  }, [batchQuery.data]);


  const effectiveOccasion: Occasion = useMemo(() => {
    const fromBatch = outfits[0]?.occasion;
    if (fromBatch && (OCCASIONS as string[]).includes(fromBatch)) {
      return fromBatch as Occasion;
    }
    return searchOccasion ?? "office";
  }, [outfits, searchOccasion]);

  // Track which look is centered (mobile horizontal scroll)
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
      navigate({
        to: "/today/looks",
        search: { batch: result.batch_id, occasion: effectiveOccasion },
        replace: true,
      });
      qc.invalidateQueries({ queryKey: ["recent-outfits"] });
    } catch {
      toast("Couldn't reshuffle.");
    } finally {
      setShuffling(false);
    }
  }

  const loading =
    (searchBatch && batchQuery.isLoading) || wardrobeQuery.isLoading;

  // Build the panels (looks + invitations for missing slots)
  const panels = useMemo(() => {
    const list: Array<
      | { kind: "look"; outfit: OutfitRecord; index: number }
      | { kind: "invite"; index: number }
    > = [];
    outfits.forEach((o, i) => list.push({ kind: "look", outfit: o, index: i }));
    while (list.length < 2 && outfits.length > 0) {
      list.push({ kind: "invite", index: list.length });
    }
    if (outfits.length > 0 && outfits.length < 3) {
      list.push({ kind: "invite", index: outfits.length });
    }
    return list;
  }, [outfits]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.52, ease: ease.luxury }}
      className="fixed inset-0 z-30 flex flex-col bg-bone"
    >
      {/* 40px topbar */}
      <header className="flex h-10 shrink-0 items-center border-b border-linen bg-bone/95 px-4 backdrop-blur">
        <Link
          to="/today"
          search={{ occasion: effectiveOccasion }}
          className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-ink transition-colors hover:text-graphite"
          aria-label="Back to Today"
        >
          <ChevronLeft className="h-3.5 w-3.5" strokeWidth={1.5} />
          Today
        </Link>

        <div className="flex flex-1 items-center justify-center gap-1.5">
          {panels.length > 0 &&
            panels.map((_, i) => (
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

        <motion.button
          {...tap}
          onClick={handleShuffle}
          disabled={shuffling || loading || outfits.length === 0}
          aria-label="Shuffle"
          className="flex h-7 w-7 items-center justify-center text-ink transition-colors hover:text-graphite disabled:opacity-40"
        >
          <motion.span
            animate={shuffling ? { rotate: 360 } : { rotate: 0 }}
            transition={{ duration: 0.6, ease: ease.luxury }}
            className="inline-flex"
          >
            <Shuffle className="h-3.5 w-3.5" strokeWidth={1.5} />
          </motion.span>
        </motion.button>
      </header>

      {/* Body */}
      {loading ? (
        <div className="flex flex-1 items-center justify-center">
          <ComposingDots />
        </div>
      ) : outfits.length === 0 ? (
        <EmptyState onAdd={() => navigate({ to: "/wardrobe" })} />
      ) : (
        <div
          ref={pagerRef}
          className="atelier-pager flex flex-1 snap-x snap-mandatory overflow-x-auto overflow-y-hidden lg:snap-none lg:overflow-x-hidden"
          style={{ scrollbarWidth: "none" }}
        >
          {panels.map((p, i) =>
            p.kind === "look" ? (
              <LookPanel
                key={p.outfit.id}
                outfit={p.outfit}
                index={p.index}
                items={(p.outfit.item_ids ?? [])
                  .map((id) => itemsById.get(id))
                  .filter(Boolean) as ItemFull[]}
                isActive={activeIndex === i}
                totalPanels={panels.length}
                onNavigate={navigate}
              />
            ) : (
              <InvitePanel
                key={`invite-${i}`}
                index={p.index}
                totalPanels={panels.length}
                onAdd={() => navigate({ to: "/wardrobe" })}
              />
            ),
          )}
        </div>
      )}

      <style>{`.atelier-pager::-webkit-scrollbar{display:none}`}</style>
    </motion.div>
  );
}

/* ─────────────────────────── Composing dots ─────────────────────────── */

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

/* ─────────────────────────── Look panel ─────────────────────────── */

function LookPanel({
  outfit,
  index,
  items,
  isActive,
  totalPanels,
  onNavigate,
}: {
  outfit: OutfitRecord;
  index: number;
  items: ItemFull[];
  isActive: boolean;
  totalPanels: number;
  onNavigate: ReturnType<typeof useNavigate>;
}) {
  const [saved, setSaved] = useState(outfit.saved ?? false);
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    if (isActive && !revealed) {
      const t = setTimeout(() => setRevealed(true), 80);
      return () => clearTimeout(t);
    }
  }, [isActive, revealed]);

  // Order items: bottom → top → shoes → outerwear → accessories
  const stack = useMemo(() => {
    const order = ["outerwear", "top", "dress", "bottom", "shoes"];
    const main = items
      .filter((i) => order.includes(i.category ?? ""))
      .sort(
        (a, b) =>
          order.indexOf(a.category ?? "") - order.indexOf(b.category ?? ""),
      );
    const accessories = items.filter((i) =>
      ["accessory", "bag"].includes(i.category ?? ""),
    );
    return { main, accessories };
  }, [items]);

  // Animation order: bottom, top, shoes, outerwear, accessories
  const animOrder = useMemo(() => {
    const cats = ["bottom", "top", "dress", "shoes", "outerwear"];
    const map = new Map<string, number>();
    let n = 0;
    cats.forEach((c) => {
      items.forEach((i) => {
        if (i.category === c) map.set(i.id, n++);
      });
    });
    items.forEach((i) => {
      if (!map.has(i.id)) map.set(i.id, n++);
    });
    return map;
  }, [items]);

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

  // (Items are split into left/right callout sides inside LookHero)

  return (
    <section
      data-look-index={index}
      className="relative flex h-full w-full shrink-0 snap-start flex-col"
      style={{
        flexBasis: totalPanels > 1 ? `${100 / Math.min(totalPanels, 3)}%` : "100%",
        background:
          "linear-gradient(180deg, var(--linen) 0%, color-mix(in oklab, var(--linen), var(--ink) 4%) 100%)",
      }}
    >
      {/* Top: eyebrow + name */}
      <div className="px-6 pt-6 text-center md:pt-10">
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
          className="mt-3 font-display text-[28px] font-normal leading-[1.1] text-graphite md:text-[36px]"
        >
          {outfit.name ?? `Look ${index + 1}`}
        </motion.h2>
      </div>

      {/* Composition zone — LOOK 6 style: AI-rendered model image with callout labels */}
      <div className="relative flex flex-1 items-center justify-center px-3 py-4 md:px-6 md:py-6">
        <LookHero
          outfit={outfit}
          items={items}
          stack={stack}
          animOrder={animOrder}
          revealed={revealed}
        />
      </div>


      {/* Rationale */}
      {outfit.rationale && (
        <motion.p
          initial={{ opacity: 0 }}
          animate={revealed ? { opacity: 1 } : {}}
          transition={{ duration: 0.5, delay: 0.7, ease: ease.luxury }}
          className="mx-auto mt-4 max-w-[480px] px-8 text-center font-display text-[16px] font-light italic leading-[1.45] text-graphite md:text-[18px]"
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

      {/* Action row */}
      <div className="flex shrink-0 justify-center px-6 pb-8 pt-6">
        <div className="flex w-[280px] items-center justify-between">
          <ActionIcon
            label="SAVE"
            icon={<Bookmark className="h-3.5 w-3.5" strokeWidth={1.5} />}
            active={saved}
            onClick={handleSave}
          />
          <ActionIcon
            label="WEAR"
            icon={<Check className="h-3.5 w-3.5" strokeWidth={1.5} />}
            onClick={handleWear}
          />
          <ActionIcon
            label="DETAILS"
            icon={<ArrowRight className="h-3.5 w-3.5" strokeWidth={1.5} />}
            onClick={() =>
              onNavigate({ to: "/outfit/$id", params: { id: outfit.id } })
            }
          />
          <ActionIcon
            label="SHARE"
            icon={<Share2 className="h-3.5 w-3.5" strokeWidth={1.5} />}
            onClick={handleShare}
          />
        </div>
      </div>
    </section>
  );
}

/* ─────────────────────────── Item stack ─────────────────────────── */

function ItemStack({
  items,
  accessories,
  animOrder,
  revealed,
}: {
  items: ItemFull[];
  accessories: ItemFull[];
  animOrder: Map<string, number>;
  revealed: boolean;
}) {
  return (
    <div className="relative">
      {items.map((item) => (
        <FlatItem
          key={item.id}
          item={item}
          delay={(animOrder.get(item.id) ?? 0) * 0.12}
          revealed={revealed}
          offsetX={item.category === "outerwear" ? -28 : 0}
          z={item.category === "outerwear" ? 1 : 2}
        />
      ))}

      {accessories.length > 0 && (
        <div className="absolute right-0 top-2 flex flex-col gap-2">
          {accessories.slice(0, 2).map((item) => (
            <motion.div
              key={item.id}
              initial={{ opacity: 0, scale: 0.92 }}
              animate={revealed ? { opacity: 1, scale: 1 } : {}}
              transition={{
                duration: 0.56,
                ease: ease.luxury,
                delay: (animOrder.get(item.id) ?? 4) * 0.12,
              }}
              className="h-14 w-14 bg-bone/40 p-1.5"
              style={{ borderRadius: "2px" }}
            >
              {(item.enhanced_path || item.thumbnail_path) && (
                <img
                  src={item.enhanced_path
                    ? supabase.storage
                        .from("wardrobe-enhanced")
                        .getPublicUrl(item.enhanced_path).data.publicUrl
                    : supabase.storage
                        .from("wardrobe-thumbs")
                        .getPublicUrl(item.thumbnail_path!).data.publicUrl}
                  alt={item.subcategory ?? ""}
                  className="h-full w-full object-contain"
                />
              )}
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
}

function FlatItem({
  item,
  delay,
  revealed,
  offsetX,
  z,
}: {
  item: ItemFull;
  delay: number;
  revealed: boolean;
  offsetX: number;
  z: number;
}) {
  const url = item.enhanced_path
    ? supabase.storage.from("wardrobe-enhanced").getPublicUrl(item.enhanced_path)
        .data.publicUrl
    : item.thumbnail_path
      ? supabase.storage.from("wardrobe-thumbs").getPublicUrl(item.thumbnail_path)
          .data.publicUrl
      : null;

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.94, y: 8 }}
      animate={revealed ? { opacity: 1, scale: 1, y: 0 } : {}}
      transition={{ duration: 0.56, ease: ease.luxury, delay }}
      className="relative -mt-3 first:mt-0"
      style={{ marginLeft: offsetX, zIndex: z }}
    >
      <div className="flex h-[120px] items-center justify-center md:h-[140px]">
        {url ? (
          <img
            src={url}
            alt={item.subcategory ?? ""}
            className="max-h-full max-w-full object-contain"
            style={{
              filter: "drop-shadow(0 4px 8px rgba(0,0,0,0.06))",
            }}
          />
        ) : (
          <div className="h-full w-24 bg-bone/40" />
        )}
      </div>
      {/* Soft ground shadow */}
      <motion.div
        aria-hidden
        initial={{ opacity: 0, scaleX: 0.6 }}
        animate={revealed ? { opacity: 0.22, scaleX: 1 } : {}}
        transition={{ duration: 0.56, ease: ease.luxury, delay: delay + 0.1 }}
        className="mx-auto -mt-1 h-1.5"
        style={{
          width: "70%",
          background: "var(--ink)",
          borderRadius: "50%",
          filter: "blur(6px)",
        }}
      />
    </motion.div>
  );
}

/* ─────────────────────────── Callout label (lg+) ─────────────────────────── */

function CalloutLabel({
  item,
  side,
  revealed,
  delay,
}: {
  item: ItemFull;
  side: "left" | "right";
  revealed: boolean;
  delay: number;
}) {
  const isLeft = side === "left";
  // SVG path: small dot at item edge → horizontal → 90° → up to label
  // Container is 140-180px wide. Path goes from edge facing center to label.
  const pathLength = 90;
  return (
    <div
      className={`pointer-events-auto flex items-center ${isLeft ? "justify-start" : "justify-end"}`}
    >
      {/* SVG line, drawn after item fades in */}
      <svg
        width="80"
        height="20"
        viewBox="0 0 80 20"
        className={`absolute ${isLeft ? "left-[120px] xl:left-[160px]" : "right-[120px] xl:right-[160px]"}`}
        style={{ top: "50%", transform: "translateY(-50%)" }}
        aria-hidden
      >
        <motion.circle
          cx={isLeft ? 78 : 2}
          cy="10"
          r="2"
          fill="var(--ink)"
          initial={{ opacity: 0 }}
          animate={revealed ? { opacity: 0.6 } : {}}
          transition={{ duration: 0.3, delay: delay + 0.4 }}
        />
        <motion.line
          x1={isLeft ? 76 : 4}
          y1="10"
          x2={isLeft ? 0 : 80}
          y2="10"
          stroke="var(--ink)"
          strokeWidth="1"
          strokeOpacity="0.5"
          initial={{ pathLength: 0 }}
          animate={revealed ? { pathLength: 1 } : {}}
          transition={{ duration: 0.42, ease: ease.luxury, delay }}
          style={{ strokeDasharray: pathLength, strokeDashoffset: 0 }}
        />
      </svg>

      {/* Label content */}
      <motion.div
        initial={{ opacity: 0, x: isLeft ? -6 : 6 }}
        animate={revealed ? { opacity: 1, x: 0 } : {}}
        transition={{ duration: 0.4, ease: ease.luxury, delay: delay + 0.3 }}
        className={`max-w-[120px] xl:max-w-[160px] ${isLeft ? "text-left" : "text-right"}`}
      >
        <p className="text-[13px] leading-tight text-graphite">
          {(item.subcategory || item.category || "item").toLowerCase()}
        </p>
        <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.16em] text-ink/60">
          {[item.material, item.color_primary].filter(Boolean).join(" · ") ||
            "—"}
        </p>
      </motion.div>
    </div>
  );
}

/* ─────────────────────────── Action icon ─────────────────────────── */

function ActionIcon({
  label,
  icon,
  active,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <motion.button
      {...tap}
      onClick={onClick}
      className="flex h-11 w-11 flex-col items-center justify-center gap-1"
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

/* ─────────────────────────── Invite panel ─────────────────────────── */

function InvitePanel({
  index,
  totalPanels,
  onAdd,
}: {
  index: number;
  totalPanels: number;
  onAdd: () => void;
}) {
  return (
    <section
      data-look-index={index}
      className="relative flex h-full w-full shrink-0 snap-start flex-col items-center justify-center px-8"
      style={{
        flexBasis: totalPanels > 1 ? `${100 / Math.min(totalPanels, 3)}%` : "100%",
        background:
          "linear-gradient(180deg, var(--linen) 0%, color-mix(in oklab, var(--linen), var(--ink) 4%) 100%)",
      }}
    >
      <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-ink">
        LOOK {String(index + 1).padStart(2, "0")}
      </p>
      <h3 className="mt-6 max-w-[360px] text-center font-display text-[28px] font-light leading-[1.15] text-graphite md:text-[32px]">
        One more piece unlocks Look {String(index + 1).padStart(2, "0")}.
      </h3>
      <p className="mt-4 max-w-[320px] text-center text-[14px] leading-relaxed text-ink">
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

/* ─────────────────────────── Empty state ─────────────────────────── */

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
        <p className="mt-4 text-[14px] leading-relaxed text-ink">
          Choose how you want to be dressed and we'll compose three looks from
          your wardrobe.
        </p>
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
