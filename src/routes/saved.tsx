import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Shell } from "@/components/Shell";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { ThreeLooksSheet } from "@/components/ThreeLooksSheet";
import { useAuth } from "@/lib/auth";
import { useThreeLooksSheet } from "@/lib/store";
import { supabase } from "@/integrations/supabase/client";
import { ease, dur, tap } from "@/lib/motion";

export const Route = createFileRoute("/saved")({
  component: () => (
    <ProtectedRoute>
      <SavedPage />
    </ProtectedRoute>
  ),
  head: () => ({ meta: [{ title: "Saved — Atelier" }] }),
});

interface SavedRow {
  id: string;
  occasion: string | null;
  name: string | null;
  rationale: string | null;
  generated_at: string | null;
  batch_id: string | null;
  item_ids: string[] | null;
  thumbUrl: string | null;
}

function SavedPage() {
  const { user } = useAuth();
  const navigate = useNavigate();

  const sheetOpen = useThreeLooksSheet((s) => s.isOpen);
  const activeBatch = useThreeLooksSheet((s) => s.batchId);
  const openSheet = useThreeLooksSheet((s) => s.open);
  const setBatchId = useThreeLooksSheet((s) => s.setBatchId);
  const closeSheet = useThreeLooksSheet((s) => s.close);

  const query = useQuery({
    queryKey: ["saved-outfits", user?.id],
    enabled: !!user,
    queryFn: async (): Promise<SavedRow[]> => {
      const { data: outfits } = await supabase
        .from("outfits")
        .select(
          "id, occasion, name, rationale, generated_at, batch_id, item_ids",
        )
        .eq("user_id", user!.id)
        .eq("saved", true)
        .order("generated_at", { ascending: false });

      const rows = outfits ?? [];

      // Collect every item id we need to thumbnail.
      const allItemIds = Array.from(
        new Set(rows.flatMap((r) => (r.item_ids ?? []) as string[])),
      );

      let itemMap = new Map<string, { thumbnail_path: string | null; enhanced_path: string | null; category: string | null }>();
      if (allItemIds.length) {
        const { data: items } = await supabase
          .from("wardrobe_items")
          .select("id, thumbnail_path, enhanced_path, category")
          .in("id", allItemIds);
        (items ?? []).forEach((it) => itemMap.set(it.id, it));
      }

      function pickThumb(ids: string[] | null): string | null {
        if (!ids?.length) return null;
        // Prefer the "top" or "dress" item; fall back to the first one with media.
        const order = ["top", "dress", "outerwear", "bottom", "shoes", "accessory", "bag"];
        const sorted = [...ids].sort((a, b) => {
          const ai = order.indexOf(itemMap.get(a)?.category ?? "zzz");
          const bi = order.indexOf(itemMap.get(b)?.category ?? "zzz");
          return ai - bi;
        });
        for (const id of sorted) {
          const it = itemMap.get(id);
          if (!it) continue;
          if (it.enhanced_path) {
            return supabase.storage
              .from("wardrobe-enhanced")
              .getPublicUrl(it.enhanced_path).data.publicUrl;
          }
          if (it.thumbnail_path) {
            return supabase.storage
              .from("wardrobe-thumbs")
              .getPublicUrl(it.thumbnail_path).data.publicUrl;
          }
        }
        return null;
      }

      return rows.map((r) => ({
        ...r,
        item_ids: (r.item_ids ?? []) as string[],
        thumbUrl: pickThumb((r.item_ids ?? []) as string[]),
      }));
    },
  });

  function handleOpen(row: SavedRow) {
    if (row.batch_id) {
      openSheet(row.batch_id);
    } else {
      navigate({ to: "/outfit/$id", params: { id: row.id } });
    }
  }

  const rows = query.data ?? [];

  return (
    <Shell>
      <div className="mx-auto max-w-[760px] px-6 py-12">
        <h1 className="font-display text-[32px] font-light text-graphite">Saved</h1>
        <p className="mt-2 font-mono text-[11px] uppercase tracking-[0.2em] text-ink">
          {rows.length} {rows.length === 1 ? "LOOK" : "LOOKS"}
        </p>

        {query.isLoading ? (
          <div className="py-32 text-center">
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink">
              Loading…
            </p>
          </div>
        ) : rows.length === 0 ? (
          <div className="py-32 text-center">
            <p className="font-display text-[24px] font-light text-graphite">
              Saved looks appear here.
            </p>
            <p className="mt-3 text-[14px] text-ink">
              Tap the bookmark on any look you want to keep.
            </p>
          </div>
        ) : (
          <ul className="mt-10 divide-y divide-linen">
            {rows.map((row, i) => (
              <motion.li
                key={row.id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{
                  delay: i * 0.035,
                  duration: dur.page,
                  ease: ease.luxury,
                }}
              >
                <motion.button
                  {...tap}
                  onClick={() => handleOpen(row)}
                  className="group flex w-full items-center gap-4 py-4 text-left"
                >
                  <div className="h-20 w-20 shrink-0 overflow-hidden bg-linen">
                    {row.thumbUrl ? (
                      <img
                        src={row.thumbUrl}
                        alt={row.name ?? "Look"}
                        loading="lazy"
                        className="h-full w-full object-contain p-1"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center font-mono text-[9px] uppercase tracking-[0.2em] text-ink/50">
                        —
                      </div>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="font-display text-[18px] font-normal leading-tight text-graphite">
                      {row.name ?? "Untitled look"}
                    </p>
                    <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.18em] text-ink">
                      {row.occasion ?? "look"}
                    </p>
                  </div>
                  <p className="shrink-0 font-mono text-[10px] uppercase tracking-[0.18em] text-ink/70">
                    {row.generated_at
                      ? new Date(row.generated_at).toLocaleDateString("en-US", {
                          day: "2-digit",
                          month: "short",
                        })
                      : ""}
                  </p>
                </motion.button>
              </motion.li>
            ))}
          </ul>
        )}
      </div>

      <ThreeLooksSheet
        open={sheetOpen}
        batchId={activeBatch}
        onClose={closeSheet}
        onBatchChanged={(b) => setBatchId(b)}
      />
    </Shell>
  );
}
