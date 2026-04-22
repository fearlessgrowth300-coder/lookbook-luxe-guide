import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Shell } from "@/components/Shell";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/integrations/supabase/client";
import { ease, dur } from "@/lib/motion";

export const Route = createFileRoute("/saved")({
  component: () => (
    <ProtectedRoute>
      <SavedPage />
    </ProtectedRoute>
  ),
  head: () => ({ meta: [{ title: "Saved — Atelier" }] }),
});

function SavedPage() {
  const { user } = useAuth();
  const navigate = useNavigate();

  const query = useQuery({
    queryKey: ["saved-outfits", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data } = await supabase
        .from("outfits")
        .select("id, occasion, rationale, generated_at")
        .eq("user_id", user!.id)
        .eq("saved", true)
        .order("generated_at", { ascending: false });
      return data ?? [];
    },
  });

  return (
    <Shell>
      <div className="mx-auto max-w-[1280px] px-6 py-12 md:px-12 lg:px-24">
        <h1 className="font-display text-[32px] font-light text-graphite">Saved</h1>
        <p className="mt-2 font-mono text-[11px] uppercase tracking-[0.2em] text-ink">
          {query.data?.length ?? 0} LOOKS
        </p>

        {query.data?.length === 0 ? (
          <div className="py-32 text-center">
            <p className="font-display text-[24px] font-light text-graphite">
              Nothing saved yet.
            </p>
            <p className="mt-3 text-[14px] text-ink">
              Save a look from the outfit page to keep it here.
            </p>
          </div>
        ) : (
          <div
            className="mt-12 grid gap-4"
            style={{ gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" }}
          >
            {query.data?.map((o, i) => (
              <motion.button
                key={o.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.035, duration: dur.page, ease: ease.luxury }}
                onClick={() => navigate({ to: "/outfit/$id", params: { id: o.id } })}
                className="group bg-linen p-5 text-left"
              >
                <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink">
                  {o.occasion}
                </p>
                <p className="mt-3 font-display text-[16px] italic leading-snug text-graphite">
                  "{o.rationale}"
                </p>
                <p className="mt-6 font-mono text-[10px] uppercase tracking-[0.16em] text-ink">
                  {new Date(o.generated_at!).toLocaleDateString()}
                </p>
              </motion.button>
            ))}
          </div>
        )}
      </div>
    </Shell>
  );
}
