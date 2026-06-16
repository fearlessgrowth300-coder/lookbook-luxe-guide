import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { motion } from "framer-motion";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Bookmark, Shuffle, Check, Share2, ArrowLeft } from "lucide-react";
import { toast } from "sonner";
import { Shell } from "@/components/Shell";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { LookHero } from "@/components/LookHero";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/integrations/supabase/client";
import { ease, dur, tap } from "@/lib/motion";
import { mockSuggestOutfit, type Occasion } from "@/lib/mock-ai";
import { renderOutfit } from "@/lib/renderOutfit.functions";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";

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
  color_primary: string | null;
  material: string | null;
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
    qc.setQueryData(["outfit", id], (current: typeof o | undefined) =>
      current
        ? {
            ...current,
            render_status: "rendering",
          }
        : current,
    );
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

  const [wornSheetOpen, setWornSheetOpen] = useState(false);
  const [dirtySelected, setDirtySelected] = useState<Set<string>>(new Set());

  const wornMutation = useMutation({
    mutationFn: async (dirtyIds: string[]) => {
      await supabase
        .from("outfits")
        .update({ worn_on: new Date().toISOString().slice(0, 10) })
        .eq("id", id);
      // Bump wear_count on each item
      const ids = outfitQuery.data?.item_ids ?? [];
      const nowIso = new Date().toISOString();
      for (const itemId of ids) {
        const { data: cur } = await supabase
          .from("wardrobe_items")
          .select("wear_count")
          .eq("id", itemId)
          .single();
        const dirty = dirtyIds.includes(itemId);
        await supabase
          .from("wardrobe_items")
          .update({
            last_worn: nowIso,
            wear_count: (cur?.wear_count ?? 0) + 1,
            ...(dirty ? { is_dirty: true, dirty_since: nowIso } : {}),
          })
          .eq("id", itemId);
      }
      return dirtyIds.length;
    },
    onSuccess: (count) => {
      navigator.vibrate?.(8);
      qc.invalidateQueries({ queryKey: ["wardrobe", user?.id] });
      toast(count > 0 ? `Noted. ${count} piece${count === 1 ? "" : "s"} sent to laundry.` : "Noted.");
      setWornSheetOpen(false);
      setDirtySelected(new Set());
    },
  });

  const shuffleMutation = useMutation({
    mutationFn: async () => {
      const { data: items } = await supabase
        .from("wardrobe_items")
        .select("id")
        .eq("user_id", user!.id)
        .eq("archived", false)
        .eq("is_dirty", false);
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
      <div className="mx-auto max-w-[1600px] px-4 py-6">
        <div className="grid gap-8">
          {/* Composition view — model wearing the outfit + callout labels */}
          <div className="relative flex min-h-[92vh] flex-col bg-bone">
            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={() => {
                  if (o.batch_id) {
                    navigate({ to: "/today", search: { batch: o.batch_id } });
                  } else if (window.history.length > 1) {
                    window.history.back();
                  } else {
                    navigate({ to: "/today" });
                  }
                }}
                className="inline-flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-graphite transition-opacity hover:opacity-60"
                aria-label="Back"
              >
                <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.5} />
                Back
              </button>
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink">
                LOOK · {String(seq).padStart(3, "0")}
              </p>
            </div>

            <motion.div
              key={o.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: dur.page, ease: ease.luxury }}
                className="mt-4 flex flex-1 items-center justify-center overflow-hidden"
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
                to="/today"
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
            <div className="sticky bottom-16 mt-12 grid grid-cols-4 gap-2 border-t border-linen bg-bone pt-6">
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
                label="I wore this"
                icon={<Check className="h-5 w-5" strokeWidth={1.25} />}
                onClick={() => {
                  setDirtySelected(new Set(items.map((i) => i.id)));
                  setWornSheetOpen(true);
                }}
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

      {/* "I wore this" — pick which pieces went into laundry */}
      <Sheet open={wornSheetOpen} onOpenChange={setWornSheetOpen}>
        <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto">
          <SheetHeader>
            <SheetTitle className="font-display text-[22px] font-light text-graphite">
              Which pieces are dirty?
            </SheetTitle>
            <SheetDescription>
              Select what needs washing. They'll move to <strong>Laundry</strong> and be skipped in
              new looks until you mark them clean.
            </SheetDescription>
          </SheetHeader>

          <div className="mt-6 space-y-2">
            <div className="flex justify-between pb-2 text-[12px]">
              <button
                type="button"
                onClick={() => setDirtySelected(new Set(items.map((i) => i.id)))}
                className="font-mono uppercase tracking-[0.14em] text-graphite hover:underline"
              >
                Select all
              </button>
              <button
                type="button"
                onClick={() => setDirtySelected(new Set())}
                className="font-mono uppercase tracking-[0.14em] text-ink hover:underline"
              >
                Clear
              </button>
            </div>

            {items.map((item) => {
              const checked = dirtySelected.has(item.id);
              const thumb = item.thumbnail_path
                ? supabase.storage.from("wardrobe-thumbs").getPublicUrl(item.thumbnail_path).data
                    .publicUrl
                : null;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setDirtySelected((prev) => {
                      const next = new Set(prev);
                      if (next.has(item.id)) next.delete(item.id);
                      else next.add(item.id);
                      return next;
                    });
                  }}
                  className={`flex w-full items-center gap-4 border p-3 text-left transition-colors ${
                    checked
                      ? "border-graphite bg-linen"
                      : "border-linen bg-bone hover:border-ink"
                  }`}
                >
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center bg-linen p-1">
                    {thumb && <img src={thumb} alt="" className="h-full w-full object-contain" />}
                  </div>
                  <div className="flex-1">
                    <p className="text-[14px] text-graphite">{item.subcategory || "—"}</p>
                    <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink">
                      {item.category}
                    </p>
                  </div>
                  <span
                    className={`flex h-5 w-5 items-center justify-center rounded-full border ${
                      checked ? "border-graphite bg-graphite text-bone" : "border-ink"
                    }`}
                  >
                    {checked && <Check className="h-3 w-3" strokeWidth={2} />}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="mt-8 flex gap-3">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => wornMutation.mutate([])}
              disabled={wornMutation.isPending}
            >
              None — all clean
            </Button>
            <Button
              className="flex-1 bg-graphite text-bone hover:bg-noir"
              onClick={() => wornMutation.mutate(Array.from(dirtySelected))}
              disabled={wornMutation.isPending}
            >
              {wornMutation.isPending
                ? "Saving…"
                : `Send ${dirtySelected.size} to laundry`}
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </Shell>
  );
}

/* (Composition is rendered by <LookHero />; the per-item ItemFrame component
 * has been retired in favor of the model-on-figure presentation.) */

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
