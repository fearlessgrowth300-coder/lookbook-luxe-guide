import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { motion, AnimatePresence } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Cloud, Calendar } from "lucide-react";
import { toast } from "sonner";
import { Shell } from "@/components/Shell";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { useAuth } from "@/lib/auth";
import { useUI, type Mood } from "@/lib/store";
import { supabase } from "@/integrations/supabase/client";
import { ease, dur, tap } from "@/lib/motion";
import {
  mockGenerateDailyPrompt,
  mockSuggestOutfits,
  type Occasion,
} from "@/server/mock-ai";
import { testRateLimit } from "@/server/functions/testRateLimit";

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

const ALL_OCCASIONS: { id: Occasion; label: string }[] = [
  { id: "office", label: "Office" },
  { id: "casual", label: "Casual" },
  { id: "evening", label: "Evening" },
  { id: "athletic", label: "Athletic" },
  { id: "formal", label: "Formal" },
  { id: "travel", label: "Travel" },
];

function TodayPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { mood, setMood } = useUI();
  const [moreOpen, setMoreOpen] = useState(false);
  const [selected, setSelected] = useState<Occasion | null>(null);
  const [generating, setGenerating] = useState(false);
  const [shake, setShake] = useState(0);

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
        .select("id, occasion, rationale, generated_at, batch_id")
        .eq("user_id", user!.id)
        .order("generated_at", { ascending: false })
        .limit(5);
      return data ?? [];
    },
  });

  // Wardrobe for occasion gating + generation
  const wardrobeQuery = useQuery({
    queryKey: ["wardrobe-count", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data } = await supabase
        .from("wardrobe_items")
        .select("id, formality_score, category, subcategory")
        .eq("user_id", user!.id)
        .eq("archived", false);
      return data ?? [];
    },
  });

  const occasionViable = (occ: Occasion) => {
    const items = wardrobeQuery.data ?? [];
    const ranges: Record<Occasion, [number, number]> = {
      office: [6, 9],
      casual: [3, 6],
      evening: [7, 10],
      athletic: [1, 3],
      formal: [9, 10],
      travel: [3, 8],
    };
    const [lo, hi] = ranges[occ];
    return (
      items.filter(
        (i) => i.formality_score && i.formality_score >= lo && i.formality_score <= hi,
      ).length >= 3
    );
  };

  function togglePill(id: Occasion) {
    setSelected((cur) => (cur === id ? null : id));
  }

  async function handleGenerate() {
    if (!selected || !user || generating) return;
    setGenerating(true);
    try {
      const wardrobe = wardrobeQuery.data ?? [];
      if (wardrobe.length < 5) {
        toast("Add at least 5 pieces to compose looks.");
        return;
      }
      const candidates = wardrobe.map((i) => ({
        id: i.id,
        category: i.category,
        subcategory: i.subcategory,
        formality_score: i.formality_score,
      }));

      const suggestions = await mockSuggestOutfits({
        user_id: user.id,
        occasion: selected,
        temp_c: 14,
        candidates,
        count: 3,
      });

      if (!suggestions.length) {
        toast(`Add a few more pieces to compose ${selected} looks.`);
        return;
      }

      const batchId = crypto.randomUUID();
      const rows = suggestions.map((s, i) => ({
        user_id: user.id,
        item_ids: s.item_ids,
        occasion: selected,
        rationale: s.rationale,
        name: s.name,
        batch_id: batchId,
        look_sequence: i + 1,
        context: { temp_c: 14, mood },
      }));
      const { error } = await supabase.from("outfits").insert(rows);
      if (error) throw error;

      navigate({ to: "/today/looks", search: { batch: batchId } });
    } catch (e) {
      console.error(e);
      setShake((s) => s + 1);
      toast("Couldn't compose looks. Try again.");
    } finally {
      setGenerating(false);
    }
  }

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

          {/* Occasion pills (selectable) */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.9, duration: dur.hover }}
            className="mt-12 flex flex-wrap items-center gap-3"
          >
            {PRIMARY_OCCASIONS.map(({ id, label }) => {
              const viable =
                (wardrobeQuery.data?.length ?? 0) === 0 || occasionViable(id);
              const isSelected = selected === id;
              const isDimmed = selected !== null && !isSelected;
              return (
                <motion.button
                  key={id}
                  {...tap}
                  disabled={!viable || generating}
                  onClick={() => togglePill(id)}
                  title={
                    !viable
                      ? `Add more pieces to unlock ${label.toLowerCase()} looks.`
                      : undefined
                  }
                  animate={{ opacity: isDimmed ? 0.5 : 1 }}
                  transition={{ duration: 0.22, ease: ease.tactile }}
                  className={`group h-10 rounded-full border border-ink px-6 text-[15px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                    isSelected
                      ? "bg-graphite text-bone"
                      : "text-graphite hover:bg-graphite hover:text-bone"
                  }`}
                  style={{
                    transitionDuration: "220ms",
                    transitionTimingFunction: "cubic-bezier(0.4,0,0.2,1)",
                  }}
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

          {/* Generate button — appears only when an occasion is selected */}
          <AnimatePresence>
            {selected && (
              <motion.div
                key="generate"
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 8 }}
                transition={{ duration: 0.32, ease: ease.luxury, delay: 0.12 }}
                className="mt-10 flex justify-center"
              >
                <motion.button
                  key={shake}
                  onClick={handleGenerate}
                  disabled={generating}
                  animate={
                    shake > 0
                      ? { x: [-4, 4, -4, 4, 0] }
                      : { scale: 1 }
                  }
                  transition={{ duration: 0.4, ease: ease.tactile }}
                  whileTap={{ scale: 0.98 }}
                  className="relative h-14 w-full max-w-[360px] bg-graphite text-bone transition-colors hover:bg-noir disabled:opacity-70"
                  style={{
                    fontFamily: "var(--font-display, Fraunces), serif",
                    fontSize: "17px",
                    letterSpacing: "0.04em",
                  }}
                >
                  {generating ? <DriftDots /> : "Generate three looks"}
                </motion.button>
              </motion.div>
            )}
          </AnimatePresence>

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

      {/* TEMP: Step 7 rate-limit verification — remove after confirming */}
      <RateLimitTester />

      {/* More occasions modal */}
      {moreOpen && (
        <MoreOccasionsModal
          currentSelected={selected}
          onClose={() => setMoreOpen(false)}
          onPick={(occ) => {
            setMoreOpen(false);
            setSelected(occ);
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

function DriftDots() {
  return (
    <span className="inline-flex items-center gap-1.5">
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="block h-1.5 w-1.5 rounded-full bg-bone"
          animate={{ opacity: [0.3, 1, 0.3], y: [0, -2, 0] }}
          transition={{
            duration: 1.2,
            repeat: Infinity,
            delay: i * 0.16,
            ease: ease.drift,
          }}
        />
      ))}
    </span>
  );
}

function MoreOccasionsModal({
  currentSelected,
  onClose,
  onPick,
}: {
  currentSelected: Occasion | null;
  onClose: () => void;
  onPick: (o: Occasion) => void;
}) {
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
          {ALL_OCCASIONS.map(({ id, label }) => {
            const isSelected = currentSelected === id;
            return (
              <motion.button
                key={id}
                {...tap}
                onClick={() => onPick(id)}
                className={`h-12 border border-ink text-[14px] transition-colors ${
                  isSelected
                    ? "bg-graphite text-bone"
                    : "text-graphite hover:bg-graphite hover:text-bone"
                }`}
              >
                {label}
              </motion.button>
            );
          })}
        </div>
      </motion.div>
    </motion.div>
  );
}
