import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { motion } from "framer-motion";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Cloud, Calendar } from "lucide-react";
import { Shell } from "@/components/Shell";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { useAuth } from "@/lib/auth";
import { useUI, type Mood } from "@/lib/store";
import { supabase } from "@/integrations/supabase/client";
import { ease, dur, tap } from "@/lib/motion";
import {
  mockGenerateDailyPrompt,
  mockSuggestOutfit,
  type Occasion,
} from "@/server/mock-ai";

export const Route = createFileRoute("/today")({
  component: () => (
    <ProtectedRoute>
      <TodayPage />
    </ProtectedRoute>
  ),
  head: () => ({ meta: [{ title: "Today — Atelier" }] }),
});

const PRIMARY_OCCASIONS: { id: Occasion; label: string }[] = [
  { id: "office", label: "Office" },
  { id: "casual", label: "Casual" },
  { id: "evening", label: "Evening" },
];

function TodayPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { mood, setMood } = useUI();
  const [moreOpen, setMoreOpen] = useState(false);

  const today = useMemo(() => new Date(), []);
  const dateLabel = useMemo(
    () =>
      today
        .toLocaleDateString("en-US", { weekday: "short", day: "2-digit", month: "short" })
        .toUpperCase()
        .replace(",", " ·"),
    [today],
  );
  const dayName = today.toLocaleDateString("en-US", { weekday: "long" });

  // Daily prompt
  const promptQuery = useQuery({
    queryKey: ["daily-prompt", user?.id, today.toDateString()],
    enabled: !!user,
    queryFn: async () => {
      const dateStr = today.toISOString().slice(0, 10);
      const { data: existing } = await supabase
        .from("daily_prompts")
        .select("*")
        .eq("user_id", user!.id)
        .eq("prompt_date", dateStr)
        .maybeSingle();
      if (existing) return existing;

      // Mock weather + archetype
      const { data: profile } = await supabase
        .from("profiles")
        .select("style_archetype")
        .eq("id", user!.id)
        .maybeSingle();

      const result = await mockGenerateDailyPrompt({
        user_id: user!.id,
        temp_c: 14,
        weather: "Overcast",
        day_of_week: dayName,
        archetype: profile?.style_archetype ?? null,
      });

      const { data: inserted } = await supabase
        .from("daily_prompts")
        .insert({
          user_id: user!.id,
          prompt_date: dateStr,
          prompt_text: result.prompt_text,
          context: result.context,
        })
        .select()
        .single();
      return inserted!;
    },
  });

  // Recent outfits
  const recentQuery = useQuery({
    queryKey: ["recent-outfits", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data } = await supabase
        .from("outfits")
        .select("id, occasion, rationale, generated_at")
        .eq("user_id", user!.id)
        .order("generated_at", { ascending: false })
        .limit(5);
      return data ?? [];
    },
  });

  // Wardrobe count for occasion gating
  const wardrobeQuery = useQuery({
    queryKey: ["wardrobe-count", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data } = await supabase
        .from("wardrobe_items")
        .select("id, formality_score, category")
        .eq("user_id", user!.id)
        .eq("archived", false);
      return data ?? [];
    },
  });

  const occasionViable = (occ: Occasion) => {
    const items = wardrobeQuery.data ?? [];
    const ranges: Record<Occasion, [number, number]> = {
      office: [7, 10],
      casual: [3, 6],
      evening: [8, 10],
      athletic: [1, 3],
      formal: [9, 10],
      travel: [1, 10],
    };
    const [lo, hi] = ranges[occ];
    return items.filter((i) => i.formality_score && i.formality_score >= lo && i.formality_score <= hi).length >= 3;
  };

  const generateMutation = useMutation({
    mutationFn: async (occasion: Occasion) => occasion,
    onSuccess: (occasion) => {
      navigate({ to: "/today/looks", search: { occasion } });
    },
  });

  const promptText = promptQuery.data?.prompt_text ?? "";
  const words = promptText.split(" ");

  return (
    <Shell>
      {/* Hero */}
      <section className="flex min-h-[calc(100vh-64px)] flex-col items-center justify-center px-6 md:min-h-[calc(100vh-64px)] md:px-12">
        <div className="w-full max-w-[680px]">
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: dur.hover, ease: ease.luxury }}
            className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink"
          >
            {dateLabel}
          </motion.p>

          <h1 className="mt-8 font-display text-[36px] font-light leading-[1.1] text-graphite md:text-[56px]">
            {promptQuery.isLoading || !promptText ? (
              <span className="inline-block h-[1.1em] w-[80%] atelier-shimmer" />
            ) : (
              words.map((w, i) => (
                <motion.span
                  key={`${w}-${i}`}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{
                    duration: 0.52,
                    delay: i * 0.06,
                    ease: ease.luxury,
                  }}
                  className="mr-[0.25em] inline-block"
                >
                  {w}
                </motion.span>
              ))
            )}
          </h1>

          {/* Occasion pills */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.9, duration: dur.hover }}
            className="mt-12 flex flex-wrap items-center gap-3"
          >
            {PRIMARY_OCCASIONS.map(({ id, label }) => {
              const viable = (wardrobeQuery.data?.length ?? 0) === 0 || occasionViable(id);
              const disabled = !viable || generateMutation.isPending;
              return (
                <motion.button
                  key={id}
                  {...tap}
                  disabled={disabled}
                  onClick={() => generateMutation.mutate(id)}
                  title={!viable ? `Add more pieces to unlock ${label.toLowerCase()} looks.` : undefined}
                  className="group h-10 rounded-full border border-ink px-6 text-[15px] text-graphite transition-colors hover:bg-graphite hover:text-bone disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-graphite"
                  style={{ transitionDuration: "220ms", transitionTimingFunction: "cubic-bezier(0.4,0,0.2,1)" }}
                >
                  {label}
                </motion.button>
              );
            })}
            <button
              onClick={() => setMoreOpen(true)}
              className="ml-2 font-mono text-[11px] uppercase tracking-[0.16em] text-ink transition-colors hover:text-graphite"
            >
              More occasions →
            </button>
          </motion.div>

          {generateMutation.isPending && (
            <p className="mt-6 font-mono text-[11px] uppercase tracking-[0.2em] text-ink">
              Composing…
            </p>
          )}
          {(wardrobeQuery.data?.length ?? 0) === 0 && (
            <p className="mt-6 text-[14px] text-ink">
              Your wardrobe is empty.{" "}
              <button
                onClick={() => navigate({ to: "/wardrobe" })}
                className="border-b border-graphite text-graphite"
              >
                Add a piece
              </button>{" "}
              to begin.
            </p>
          )}
        </div>
      </section>

      {/* Context strip */}
      <section className="border-y border-linen">
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.9, duration: dur.hover }}
          className="mx-auto flex h-14 max-w-[1280px] items-stretch px-6 md:px-12 lg:px-24"
        >
          <Cell icon={<Cloud className="h-4 w-4" strokeWidth={1.25} />} label="14° Overcast" />
          <Cell icon={<Calendar className="h-4 w-4" strokeWidth={1.25} />} label="No events" />
          <div className="flex flex-1 items-center justify-center gap-1 border-l border-linen">
            {(["sharp", "easy", "playful"] as Mood[]).map((m) => (
              <button
                key={m}
                onClick={() => setMood(m)}
                className={`h-7 px-3 font-mono text-[10px] uppercase tracking-[0.16em] transition-colors ${
                  mood === m ? "bg-graphite text-bone" : "text-ink hover:text-graphite"
                }`}
                style={{ borderRadius: "2px" }}
              >
                {m}
              </button>
            ))}
          </div>
        </motion.div>
      </section>

      {/* Recent outfits */}
      {(recentQuery.data?.length ?? 0) > 0 && (
        <section className="px-6 py-16 md:px-12 lg:px-24">
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink">
            Recent looks
          </p>
          <div className="atelier-rail mt-6 flex gap-4 overflow-x-auto pb-4">
            {recentQuery.data!.map((o) => (
              <button
                key={o.id}
                onClick={() => navigate({ to: "/outfit/$id", params: { id: o.id } })}
                className="group shrink-0 text-left"
              >
                <motion.div
                  whileHover={{ y: -4 }}
                  transition={{ duration: dur.hover, ease: ease.tactile }}
                  className="h-[260px] w-[200px] bg-linen p-4"
                >
                  <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink">
                    {o.occasion}
                  </p>
                  <p className="mt-3 font-display text-[15px] italic leading-snug text-graphite line-clamp-4">
                    {o.rationale}
                  </p>
                </motion.div>
                <div className="relative mt-3 inline-block">
                  <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink">
                    {new Date(o.generated_at!).toLocaleDateString()}
                  </span>
                  <span
                    className="absolute -bottom-1 left-0 h-px w-full origin-left scale-x-0 bg-champagne transition-transform group-hover:scale-x-100"
                    style={{ transitionDuration: "320ms", transitionTimingFunction: "cubic-bezier(0.4,0,0.2,1)" }}
                  />
                </div>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* More occasions modal */}
      {moreOpen && (
        <MoreOccasionsModal
          onClose={() => setMoreOpen(false)}
          onPick={(occ) => {
            setMoreOpen(false);
            generateMutation.mutate(occ);
          }}
        />
      )}
    </Shell>
  );
}

function Cell({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="flex flex-1 items-center justify-center gap-2 border-l border-linen first:border-l-0">
      <span className="text-ink">{icon}</span>
      <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-ink">
        {label}
      </span>
    </div>
  );
}

function MoreOccasionsModal({
  onClose,
  onPick,
}: {
  onClose: () => void;
  onPick: (o: Occasion) => void;
}) {
  const all: { id: Occasion; label: string }[] = [
    { id: "office", label: "Office" },
    { id: "casual", label: "Casual" },
    { id: "evening", label: "Evening" },
    { id: "athletic", label: "Athletic" },
    { id: "formal", label: "Formal" },
    { id: "travel", label: "Travel" },
  ];
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: dur.hover, ease: ease.tactile }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-graphite/40 px-6"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: dur.page, ease: ease.luxury }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[480px] bg-bone p-12"
        style={{ boxShadow: "0 20px 60px -20px rgba(0,0,0,0.25)", borderRadius: "2px" }}
      >
        <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink">
          Choose occasion
        </p>
        <div className="mt-6 grid grid-cols-2 gap-3">
          {all.map(({ id, label }) => (
            <motion.button
              key={id}
              {...tap}
              onClick={() => onPick(id)}
              className="h-12 border border-ink text-[14px] text-graphite transition-colors hover:bg-graphite hover:text-bone"
            >
              {label}
            </motion.button>
          ))}
        </div>
      </motion.div>
    </motion.div>
  );
}
