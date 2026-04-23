import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { motion } from "framer-motion";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { Bookmark, Shuffle, Check, Share2 } from "lucide-react";
import { toast } from "sonner";
import { Shell } from "@/components/Shell";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { LookHero } from "@/components/LookHero";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/integrations/supabase/client";
import { ease, dur, tap } from "@/lib/motion";
import { mockSuggestOutfit, type Occasion } from "@/server/mock-ai";
import { renderOutfit } from "@/server/functions/renderOutfit";

export const Route = createFileRoute("/outfit/$id")({
  component: () => (
    <ProtectedRoute>
      <OutfitPage />
    </ProtectedRoute>
  ),
  head: () => ({ meta: [{ title: "Look — Atelier" }] }),
});

interface ItemMini {
  id: string;
  thumbnail_path: string | null;
  enhanced_path: string | null;
  category: string | null;
  subcategory: string | null;
  formality_score: number | null;
}

function OutfitPage() {
  const { id } = Route.useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const outfitQuery = useQuery({
    queryKey: ["outfit", id],
    enabled: !!user,
    // Poll every 4s while the AI render is still composing
    refetchInterval: (query) => {
      const o = query.state.data as
        | { render_path?: string | null; render_status?: string | null }
        | undefined;
      if (!o) return false;
      if (o.render_path) return false;
      if (o.render_status === "failed") return false;
      return 4000;
    },
    queryFn: async () => {
      const { data, error } = await supabase
        .from("outfits")
        .select("*")
        .eq("id", id)
        .single();
      if (error) throw error;
      return data;
    },
  });

  const itemsQuery = useQuery({
    queryKey: ["outfit-items", id, outfitQuery.data?.item_ids],
    enabled: !!outfitQuery.data?.item_ids?.length,
    queryFn: async () => {
      const { data } = await supabase
        .from("wardrobe_items")
        .select(
          "id, thumbnail_path, enhanced_path, category, subcategory, color_primary, material, formality_score",
        )
        .in("id", outfitQuery.data!.item_ids);
      return (data ?? []) as ItemMini[];
    },
  });

  // Trigger AI render once if it hasn't been kicked off yet
  const renderRequestedRef = useRef(false);
  useEffect(() => {
    const o = outfitQuery.data;
    if (!o) return;
    if (o.render_path) return;
    if (o.render_status === "rendering") return;
    if (o.render_status === "failed") return;
    if (renderRequestedRef.current) return;
    renderRequestedRef.current = true;
    renderOutfit({ data: { outfit_id: o.id } })
      .then(() => qc.invalidateQueries({ queryKey: ["outfit", id] }))
      .catch((err) => console.error("[renderOutfit] failed", err));
  }, [outfitQuery.data, qc, id]);

  // Sequence number from outfit count
  const sequenceQuery = useQuery({
    queryKey: ["outfit-sequence", user?.id, id],
    enabled: !!user && !!outfitQuery.data,
    queryFn: async () => {
      const { count } = await supabase
        .from("outfits")
        .select("*", { count: "exact", head: true })
        .eq("user_id", user!.id)
        .lte("generated_at", outfitQuery.data!.generated_at!);
      return count ?? 1;
    },
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from("outfits")
        .update({ saved: !outfitQuery.data?.saved })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["outfit", id] });
      navigator.vibrate?.(8);
      toast(outfitQuery.data?.saved ? "Removed" : "Saved");
    },
  });

  const wornMutation = useMutation({
    mutationFn: async () => {
      await supabase
        .from("outfits")
        .update({ worn_on: new Date().toISOString().slice(0, 10) })
        .eq("id", id);
      // Bump wear_count on each item
      const ids = outfitQuery.data?.item_ids ?? [];
      for (const itemId of ids) {
        const { data: cur } = await supabase
          .from("wardrobe_items")
          .select("wear_count")
          .eq("id", itemId)
          .single();
        await supabase
          .from("wardrobe_items")
          .update({
            last_worn: new Date().toISOString(),
            wear_count: (cur?.wear_count ?? 0) + 1,
          })
          .eq("id", itemId);
      }
    },
    onSuccess: () => {
      navigator.vibrate?.(8);
      toast("Noted.");
    },
  });

  const shuffleMutation = useMutation({
    mutationFn: async () => {
      const { data: items } = await supabase
        .from("wardrobe_items")
        .select("id")
        .eq("user_id", user!.id)
        .eq("archived", false);
      const result = await mockSuggestOutfit({
        user_id: user!.id,
        occasion: outfitQuery.data!.occasion as Occasion,
        temp_c: 14,
        candidate_item_ids: (items ?? []).map((i) => i.id),
      });
      const { data: newOutfit, error } = await supabase
        .from("outfits")
        .insert({
          user_id: user!.id,
          item_ids: result.item_ids,
          occasion: outfitQuery.data!.occasion,
          rationale: result.rationale,
          context: outfitQuery.data!.context,
        })
        .select()
        .single();
      if (error) throw error;
      return newOutfit;
    },
    onSuccess: (o) => {
      navigator.vibrate?.(8);
      navigate({ to: "/outfit/$id", params: { id: o.id }, replace: true });
    },
  });

  const rateMutation = useMutation({
    mutationFn: async (n: number) => {
      await supabase.from("outfits").update({ user_rating: n }).eq("id", id);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["outfit", id] }),
  });

  if (outfitQuery.isLoading || !outfitQuery.data) {
    return (
      <Shell>
        <div className="flex min-h-[60vh] items-center justify-center">
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink">Loading look</p>
        </div>
      </Shell>
    );
  }

  const o = outfitQuery.data;
  const items = itemsQuery.data ?? [];
  const seq = sequenceQuery.data ?? 1;

  return (
    <Shell>
      <div className="mx-auto max-w-[1280px] px-6 py-8 md:px-12 lg:px-24">
        <div className="grid gap-12 lg:grid-cols-[3fr_2fr]">
          {/* Composition view — model wearing the outfit + callout labels */}
          <div className="relative flex min-h-[70vh] flex-col bg-bone">
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink">
              LOOK · {String(seq).padStart(3, "0")}
            </p>

            <motion.div
              key={o.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: dur.page, ease: ease.luxury }}
              className="mt-6 flex flex-1 items-center justify-center"
              style={{
                background:
                  "linear-gradient(180deg, var(--linen) 0%, color-mix(in oklab, var(--linen), var(--ink) 4%) 100%)",
              }}
            >
              <LookHero
                outfit={{
                  id: o.id,
                  name: o.name ?? null,
                  render_path: o.render_path ?? null,
                  render_status: o.render_status ?? null,
                }}
                items={items}
                size="lg"
              />
            </motion.div>
          </div>

          {/* Rationale panel */}
          <div className="flex flex-col">
            <span className="inline-flex w-fit items-center rounded-full border border-graphite px-3 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-graphite">
              {o.occasion}
            </span>

            <p className="mt-8 font-display text-[22px] font-light italic leading-[1.4] text-graphite">
              "{o.rationale}"
            </p>

            {o.batch_id && (
              <Link
                to="/today/looks"
                search={{ batch: o.batch_id }}
                className="mt-4 inline-flex w-fit items-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-ink transition-colors hover:text-graphite"
              >
                See full set →
              </Link>
            )}

            <div className="mt-12 space-y-3">
              {items.map((item) => (
                <Link
                  key={item.id}
                  to="/wardrobe"
                  className="flex items-center gap-4 border-b border-linen pb-3 transition-opacity hover:opacity-60"
                >
                  <div className="h-10 w-10 shrink-0 bg-linen p-1">
                    {item.thumbnail_path && (
                      <img
                        src={
                          supabase.storage
                            .from("wardrobe-thumbs")
                            .getPublicUrl(item.thumbnail_path).data.publicUrl
                        }
                        alt={item.subcategory || ""}
                        className="h-full w-full object-contain"
                      />
                    )}
                  </div>
                  <div className="flex-1">
                    <p className="text-[14px] text-graphite">{item.subcategory || "—"}</p>
                    <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink">
                      {item.category}
                    </p>
                  </div>
                  {item.formality_score && (
                    <span
                      className="h-1.5 w-1.5 rounded-full"
                      style={{
                        backgroundColor:
                          item.formality_score >= 8
                            ? "var(--graphite)"
                            : item.formality_score >= 5
                              ? "var(--ink)"
                              : "var(--linen)",
                      }}
                      title={`Formality ${item.formality_score}`}
                    />
                  )}
                </Link>
              ))}
            </div>

            {/* Actions */}
            <div className="sticky bottom-16 mt-12 grid grid-cols-4 gap-2 border-t border-linen bg-bone pt-6 md:bottom-0">
              <ActionBtn
                label="Save"
                icon={
                  <Bookmark
                    className="h-5 w-5"
                    strokeWidth={1.25}
                    fill={o.saved ? "currentColor" : "none"}
                  />
                }
                onClick={() => saveMutation.mutate()}
                bumped={o.saved ?? false}
              />
              <ActionBtn
                label="Shuffle"
                icon={<Shuffle className="h-5 w-5" strokeWidth={1.25} />}
                onClick={() => shuffleMutation.mutate()}
                loading={shuffleMutation.isPending}
              />
              <ActionBtn
                label="Worn"
                icon={<Check className="h-5 w-5" strokeWidth={1.25} />}
                onClick={() => wornMutation.mutate()}
              />
              <ActionBtn
                label="Share"
                icon={<Share2 className="h-5 w-5" strokeWidth={1.25} />}
                onClick={() => toast("Sharing in Pass 2")}
              />
            </div>

            {/* Rating */}
            <div className="mt-8 flex items-center gap-3">
              <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink">Rate</p>
              <div className="flex gap-2">
                {[1, 2, 3, 4, 5].map((n) => {
                  const filled = (o.user_rating ?? 0) >= n;
                  return (
                    <motion.button
                      {...tap}
                      key={n}
                      onClick={() => rateMutation.mutate(n)}
                      transition={{ delay: filled ? n * 0.08 : 0 }}
                      className="h-3 w-3 rounded-full border border-graphite"
                      style={{
                        backgroundColor: filled ? "var(--graphite)" : "transparent",
                        transition: "background-color 220ms cubic-bezier(0.4,0,0.2,1)",
                      }}
                      aria-label={`Rate ${n}`}
                    />
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
    </Shell>
  );
}

const AREA_MAP: Record<string, string> = {
  top: "top",
  bottom: "bottom",
  outerwear: "outerwear",
  dress: "top",
  shoes: "shoes",
  accessory: "accessory",
  bag: "accessory",
};

function ItemFrame({
  item,
  index,
  dimmed,
  onHover,
}: {
  item: ItemMini;
  index: number;
  dimmed: boolean;
  onHover: (h: boolean) => void;
}) {
  const area = AREA_MAP[item.category || "top"] || "top";
  const url = item.enhanced_path
    ? supabase.storage.from("wardrobe-enhanced").getPublicUrl(item.enhanced_path).data.publicUrl
    : item.thumbnail_path
      ? supabase.storage.from("wardrobe-thumbs").getPublicUrl(item.thumbnail_path).data.publicUrl
      : null;

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.92, y: 16 }}
      animate={{ opacity: dimmed ? 0.4 : 1, scale: 1, y: 0 }}
      transition={{
        opacity: { duration: dur.hover, ease: ease.tactile },
        scale: { duration: dur.page, ease: ease.luxury, delay: index * 0.12 },
        y: { duration: dur.page, ease: ease.luxury, delay: index * 0.12 },
      }}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      style={{ gridArea: area }}
      className="relative flex min-h-[160px] items-center justify-center bg-linen p-4"
    >
      {url ? (
        <img src={url} alt={item.subcategory || ""} className="max-h-[200px] w-full object-contain" />
      ) : (
        <div className="h-full w-full atelier-shimmer" />
      )}
      <span className="absolute -bottom-6 left-0 font-mono text-[10px] uppercase tracking-[0.16em] text-ink opacity-0 transition-opacity duration-220 group-hover:opacity-100">
        {item.subcategory}
      </span>
    </motion.div>
  );
}

function ActionBtn({
  label,
  icon,
  onClick,
  loading,
  bumped,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  loading?: boolean;
  bumped?: boolean;
}) {
  return (
    <motion.button
      {...tap}
      onClick={onClick}
      disabled={loading}
      animate={bumped ? { scale: [1, 1.15, 1] } : { scale: 1 }}
      transition={{ duration: 0.32, ease: ease.luxury }}
      className="flex flex-col items-center gap-2 py-2 text-graphite hover:text-noir disabled:opacity-50"
    >
      {icon}
      <span className="font-mono text-[10px] uppercase tracking-[0.16em]">{label}</span>
    </motion.button>
  );
}
