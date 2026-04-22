import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { motion, AnimatePresence } from "framer-motion";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, Shuffle } from "lucide-react";
import { toast } from "sonner";
import { Shell } from "@/components/Shell";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/integrations/supabase/client";
import { ease, dur, tap } from "@/lib/motion";
import { mockSuggestOutfits, type Occasion } from "@/server/mock-ai";

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
  validateSearch: (search: Record<string, unknown>) => {
    const occ = search.occasion;
    const valid =
      typeof occ === "string" && (OCCASIONS as string[]).includes(occ)
        ? (occ as Occasion)
        : ("office" as Occasion);
    return { occasion: valid };
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
  context: any;
}

function ThreeLooksPage() {
  const { occasion } = Route.useSearch();
  const { user } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const [outfits, setOutfits] = useState<OutfitRecord[]>([]);
  const [names, setNames] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [shuffling, setShuffling] = useState(false);
  const [missingMsg, setMissingMsg] = useState<string | null>(null);
  const generatedRef = useRef(false);

  // Wardrobe with category info for compose & display
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

  async function generate(excludeSigs: string[][] = []) {
    if (!user || !wardrobeQuery.data) return;
    const candidates = wardrobeQuery.data.map((i) => ({
      id: i.id,
      category: i.category,
      subcategory: i.subcategory,
      formality_score: i.formality_score,
    }));
    const suggestions = await mockSuggestOutfits({
      user_id: user.id,
      occasion,
      temp_c: 14,
      candidates,
      count: 3,
      exclude_signatures: excludeSigs,
    });

    if (!suggestions.length) {
      setOutfits([]);
      setNames([]);
      return;
    }

    // Three outfits generated together share a batch_id, ordered by look_sequence.
    const batchId = crypto.randomUUID();
    const rows = suggestions.map((s, i) => ({
      user_id: user.id,
      item_ids: s.item_ids,
      occasion,
      rationale: s.rationale,
      name: s.name,
      batch_id: batchId,
      look_sequence: i + 1,
      context: { temp_c: 14 },
    }));
    const { error: insertErr } = await supabase.from("outfits").insert(rows);
    if (insertErr) throw insertErr;

    // Fetch back via batch_id, ordered by look_sequence
    const { data: fetched, error: fetchErr } = await supabase
      .from("outfits")
      .select("*")
      .eq("batch_id", batchId)
      .order("look_sequence", { ascending: true });
    if (fetchErr) throw fetchErr;

    const rows2 = (fetched ?? []) as OutfitRecord[];
    setOutfits(rows2);
    setNames(rows2.map((r) => r.name ?? ""));

    if (suggestions.length < 3) {
      const have = suggestions.length;
      setMissingMsg(
        `We can build ${have} ${occasion} look${have === 1 ? "" : "s"}. Add more pieces to unlock more variations.`,
      );
    } else {
      setMissingMsg(null);
    }
  }

  // Initial generation once wardrobe loads
  useEffect(() => {
    if (
      generatedRef.current ||
      !user ||
      wardrobeQuery.isLoading ||
      !wardrobeQuery.data
    )
      return;
    generatedRef.current = true;
    setLoading(true);
    generate()
      .catch((e) => {
        console.error(e);
        toast("Couldn't compose looks");
      })
      .finally(() => setLoading(false));
  }, [user, wardrobeQuery.isLoading, wardrobeQuery.data]);

  async function handleShuffle() {
    if (shuffling || !outfits.length) return;
    setShuffling(true);
    const sigs = outfits.map((o) => o.item_ids);
    try {
      await generate(sigs);
    } catch (e) {
      console.error(e);
      toast("Couldn't reshuffle");
    } finally {
      setShuffling(false);
    }
  }

  const itemCount = wardrobeQuery.data?.length ?? 0;
  const tooFewItems = !wardrobeQuery.isLoading && itemCount < 5;

  // Empty state
  if (tooFewItems) {
    return (
      <Shell>
        <section className="flex min-h-[calc(100vh-128px)] items-center justify-center px-6 md:px-12">
          <div className="max-w-[520px] text-center">
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink">
              {occasion}
            </p>
            <h1 className="mt-6 font-display text-[28px] font-light leading-[1.2] text-graphite">
              Your wardrobe is just getting started.
            </h1>
            <p className="mt-4 text-[15px] leading-relaxed text-ink">
              Add at least 5 pieces across tops, bottoms, and shoes so we can
              compose a real look.
            </p>
            <button
              onClick={() => navigate({ to: "/wardrobe" })}
              className="mt-8 h-12 border border-ink px-8 text-[14px] text-graphite transition-colors hover:bg-graphite hover:text-bone"
            >
              Add a piece
            </button>
          </div>
        </section>
      </Shell>
    );
  }

  return (
    <Shell>
      {/* Sub-header */}
      <header className="sticky top-16 z-30 flex h-[72px] items-center border-b border-linen bg-bone/95 px-6 backdrop-blur md:px-12 lg:px-24">
        <Link
          to="/today"
          className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.2em] text-ink transition-colors hover:text-graphite"
        >
          <ChevronLeft className="h-4 w-4" strokeWidth={1.25} />
          Today
        </Link>
        <p className="flex-1 text-center font-mono text-[11px] uppercase tracking-[0.2em] text-graphite">
          THREE LOOKS · {occasion.toUpperCase()} · 14°C
        </p>
        <motion.button
          {...tap}
          onClick={handleShuffle}
          disabled={shuffling || loading || !outfits.length}
          aria-label="Shuffle"
          className="flex h-9 w-9 items-center justify-center text-ink transition-colors hover:text-graphite disabled:opacity-40"
        >
          <motion.span
            animate={shuffling ? { rotate: 360 } : { rotate: 0 }}
            transition={{ duration: 0.6, ease: ease.luxury }}
            className="inline-flex"
          >
            <Shuffle className="h-5 w-5" strokeWidth={1.25} />
          </motion.span>
        </motion.button>
      </header>

      {/* Body */}
      {loading || wardrobeQuery.isLoading ? (
        <div className="flex min-h-[60vh] items-center justify-center">
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink">
            Composing three looks…
          </p>
        </div>
      ) : (
        <>
          <div className="px-6 py-12 md:px-12 lg:px-24">
            <AnimatePresence mode="wait">
              <motion.div
                key={outfits.map((o) => o.id).join("|") || "empty"}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: dur.hover }}
                className="grid gap-8 lg:grid-cols-3"
              >
                {outfits.map((o, i) => (
                  <LookCard
                    key={o.id}
                    outfit={o}
                    index={i}
                    name={names[i] ?? `Look ${i + 1}`}
                    items={(o.item_ids ?? [])
                      .map((id) => itemsById.get(id))
                      .filter(Boolean) as ItemFull[]}
                    onSaved={() =>
                      qc.invalidateQueries({ queryKey: ["wardrobe-full"] })
                    }
                  />
                ))}
              </motion.div>
            </AnimatePresence>

            {missingMsg && (
              <div className="mt-12 bg-linen p-6 text-center">
                <p className="text-[14px] italic text-ink">{missingMsg}</p>
              </div>
            )}
          </div>

          {/* Mobile dot indicator */}
          {outfits.length > 1 && <DotIndicator count={outfits.length} />}
        </>
      )}
    </Shell>
  );
}

function LookCard({
  outfit,
  index,
  name,
  items,
  onSaved,
}: {
  outfit: OutfitRecord;
  index: number;
  name: string;
  items: ItemFull[];
  onSaved: () => void;
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [saved, setSaved] = useState(outfit.saved ?? false);

  const ordered = useMemo(() => {
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

  async function handleSave() {
    const next = !saved;
    setSaved(next);
    await supabase.from("outfits").update({ saved: next }).eq("id", outfit.id);
    navigator.vibrate?.(8);
    toast(next ? "Saved" : "Removed");
    onSaved();
  }

  async function handleWear() {
    const today = new Date().toISOString().slice(0, 10);
    await supabase.from("outfits").update({ worn_on: today }).eq("id", outfit.id);
    for (const item of items) {
      await supabase
        .from("wardrobe_items")
        .update({
          last_worn: new Date().toISOString(),
          wear_count: (1 as number),
        })
        .eq("id", item.id);
    }
    navigator.vibrate?.(8);
    toast("Noted.");
    qc.invalidateQueries({ queryKey: ["wardrobe-full"] });
  }

  return (
    <motion.section
      data-look-index={index}
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: dur.page, ease: ease.luxury, delay: index * 0.08 }}
      className="bg-linen p-8"
    >
      <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-ink">
        LOOK {String(index + 1).padStart(2, "0")}
      </p>
      <h2 className="mt-3 font-display text-[28px] font-normal leading-[1.15] text-graphite">
        {name}
      </h2>

      {/* Composition */}
      <div className="mt-8 flex justify-center">
        <div className="relative w-full max-w-[300px]">
          {ordered.main.map((item, i) => (
            <ItemFlat key={item.id} item={item} delay={i * 0.12} />
          ))}
          {ordered.accessories.length > 0 && (
            <div className="absolute right-0 top-0 flex flex-col gap-2">
              {ordered.accessories.slice(0, 2).map((item, i) => (
                <motion.div
                  key={item.id}
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{
                    duration: dur.page,
                    ease: ease.luxury,
                    delay: 0.4 + i * 0.12,
                  }}
                  className="h-16 w-16 bg-bone p-1.5"
                >
                  {item.thumbnail_path && (
                    <img
                      src={
                        supabase.storage
                          .from("wardrobe-thumbs")
                          .getPublicUrl(item.thumbnail_path).data.publicUrl
                      }
                      alt={item.subcategory ?? ""}
                      className="h-full w-full object-contain"
                    />
                  )}
                </motion.div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Item legend */}
      <ul className="mt-8 space-y-2">
        {items.map((item) => (
          <li
            key={item.id}
            className="flex items-baseline justify-between gap-3 border-b border-bone/60 pb-2"
          >
            <span className="text-[13px] text-graphite">
              {item.subcategory || item.category || "—"}
            </span>
            <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink/70">
              {item.material || item.color_primary || ""}
            </span>
          </li>
        ))}
      </ul>

      {/* Rationale */}
      {outfit.rationale && (
        <p className="mt-6 font-display text-[17px] font-light italic leading-[1.4] text-graphite line-clamp-3">
          {outfit.rationale}
        </p>
      )}

      {/* Actions */}
      <div className="mt-8 flex gap-2">
        <ActionPill label={saved ? "SAVED" : "SAVE"} active={saved} onClick={handleSave} />
        <ActionPill label="WEAR IT" onClick={handleWear} />
        <ActionPill
          label="DETAILS"
          onClick={() =>
            navigate({ to: "/outfit/$id", params: { id: outfit.id } })
          }
        />
      </div>
    </motion.section>
  );
}

function ItemFlat({ item, delay }: { item: ItemFull; delay: number }) {
  const url = item.enhanced_path
    ? supabase.storage.from("wardrobe-enhanced").getPublicUrl(item.enhanced_path).data.publicUrl
    : item.thumbnail_path
      ? supabase.storage.from("wardrobe-thumbs").getPublicUrl(item.thumbnail_path).data.publicUrl
      : null;

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.94, y: 8 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={{ duration: dur.page, ease: ease.luxury, delay }}
      className="relative mx-auto -mt-2 first:mt-0"
    >
      <div className="flex h-[140px] items-center justify-center">
        {url ? (
          <img
            src={url}
            alt={item.subcategory ?? ""}
            className="max-h-[140px] max-w-full object-contain"
          />
        ) : (
          <div className="h-full w-32 bg-bone/40" />
        )}
      </div>
      {/* Soft ground shadow */}
      <div
        aria-hidden
        className="mx-auto h-2 rounded-[50%]"
        style={{
          width: "80%",
          background: "var(--ink)",
          opacity: 0.18,
          filter: "blur(8px)",
        }}
      />
    </motion.div>
  );
}

function ActionPill({
  label,
  active,
  onClick,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <motion.button
      {...tap}
      onClick={onClick}
      className={`flex-1 border border-ink px-3 py-2 font-mono text-[10px] uppercase tracking-[0.16em] transition-colors ${
        active
          ? "bg-graphite text-bone"
          : "text-graphite hover:bg-graphite hover:text-bone"
      }`}
    >
      {label}
    </motion.button>
  );
}

function DotIndicator({ count }: { count: number }) {
  const [active, setActive] = useState(0);

  useEffect(() => {
    function onScroll() {
      const cards = document.querySelectorAll<HTMLElement>("[data-look-index]");
      let best = 0;
      let bestDist = Infinity;
      const mid = window.innerHeight / 2;
      cards.forEach((el, i) => {
        const r = el.getBoundingClientRect();
        const d = Math.abs(r.top + r.height / 2 - mid);
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      });
      setActive(best);
    }
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div className="fixed right-4 top-1/2 z-30 flex -translate-y-1/2 flex-col gap-3 lg:hidden">
      {Array.from({ length: count }).map((_, i) => (
        <button
          key={i}
          aria-label={`Look ${i + 1}`}
          onClick={() => {
            const el = document.querySelector<HTMLElement>(
              `[data-look-index="${i}"]`,
            );
            el?.scrollIntoView({ behavior: "smooth", block: "center" });
          }}
          className="h-2 w-2 rounded-full transition-colors"
          style={{
            backgroundColor: active === i ? "var(--graphite)" : "var(--ink)",
            opacity: active === i ? 1 : 0.4,
          }}
        />
      ))}
    </div>
  );
}
