import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { toast } from "sonner";
import { Shell } from "@/components/Shell";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/integrations/supabase/client";
import { tap } from "@/lib/motion";

export const Route = createFileRoute("/settings")({
  component: () => (
    <ProtectedRoute>
      <SettingsPage />
    </ProtectedRoute>
  ),
  head: () => ({ meta: [{ title: "Settings — Atelier" }] }),
});

const ARCHETYPES = ["minimalist", "classic", "eclectic", "romantic", "edgy", "sporty"] as const;
const CLIMATES = ["tropical", "temperate", "continental", "cold"] as const;

function SettingsPage() {
  const { user, signOut } = useAuth();
  const qc = useQueryClient();

  const profile = useQuery({
    queryKey: ["profile", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data } = await supabase.from("profiles").select("*").eq("id", user!.id).single();
      return data;
    },
  });

  const update = useMutation({
    mutationFn: async (patch: Record<string, unknown>) => {
      const { error } = await supabase.from("profiles").update(patch).eq("id", user!.id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["profile", user?.id] });
      toast("Saved");
    },
  });

  return (
    <Shell>
      <div className="mx-auto max-w-[680px] px-6 py-16 md:px-12">
        <h1 className="font-display text-[32px] font-light text-graphite">Settings</h1>
        <p className="mt-2 text-[14px] text-ink">{user?.email}</p>

        <section className="mt-16">
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink">
            Style archetype
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            {ARCHETYPES.map((a) => {
              const active = profile.data?.style_archetype === a;
              return (
                <motion.button
                  {...tap}
                  key={a}
                  onClick={() => update.mutate({ style_archetype: a })}
                  className={`h-10 rounded-full px-5 text-[13px] capitalize transition-colors ${
                    active
                      ? "bg-graphite text-bone"
                      : "border border-ink text-ink hover:border-graphite hover:text-graphite"
                  }`}
                >
                  {a}
                </motion.button>
              );
            })}
          </div>
        </section>

        <section className="mt-12">
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink">
            Climate
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            {CLIMATES.map((c) => {
              const active = profile.data?.climate === c;
              return (
                <motion.button
                  {...tap}
                  key={c}
                  onClick={() => update.mutate({ climate: c })}
                  className={`h-10 rounded-full px-5 text-[13px] capitalize transition-colors ${
                    active
                      ? "bg-graphite text-bone"
                      : "border border-ink text-ink hover:border-graphite hover:text-graphite"
                  }`}
                >
                  {c}
                </motion.button>
              );
            })}
          </div>
        </section>

        <section className="mt-16 border-t border-linen pt-8">
          <motion.button
            {...tap}
            onClick={signOut}
            className="font-mono text-[11px] uppercase tracking-[0.16em] text-signal hover:text-graphite"
          >
            Sign out
          </motion.button>
        </section>
      </div>
    </Shell>
  );
}
